import type { FileStorage } from "./file-storage.interface";
import {
  LEGACY_STORAGE_PROFILE_ID,
  type FileStorageProfile,
  type StorageProfileRepository,
} from "./storage-profile";
import { createS3FileStorage } from "./s3-file-storage";
import { createVercelBlobStorage } from "./vercel-blob-storage";

const ACTIVE_PROFILE_TTL_MS = 2_000;
const DEFAULT_MAX_CLIENTS = 32;

export interface StorageRouterOptions {
  repository: StorageProfileRepository;
  legacyProfile: () => FileStorageProfile;
  activeTtlMs?: number;
  maxClients?: number;
  now?: () => number;
  createStorage?: (profile: FileStorageProfile) => FileStorage;
}

export interface StorageRouter extends FileStorage {
  withProfile(profileId: string): FileStorage;
  withActive<T>(
    operation: (storage: FileStorage, profile: FileStorageProfile) => Promise<T>,
  ): Promise<T>;
}

export function createProfileStorage(profile: FileStorageProfile): FileStorage {
  if (profile.id === LEGACY_STORAGE_PROFILE_ID) {
    if (profile.driver === "vercel-blob") return createVercelBlobStorage();
    throw new Error("LEGACY_S3_STORAGE_NOT_SUPPORTED");
  }
  if (profile.driver === "vercel-blob")
    throw new Error("VERCEL_BLOB_PROFILE_NOT_SUPPORTED");
  if (!profile.s3) {
    throw new Error(`Storage profile ${profile.id} is missing S3 configuration`);
  }
  return createS3FileStorage({
    ...profile.s3,
    forcePathStyle:
      profile.driver === "minio" ? true : profile.s3.forcePathStyle,
  });
}

export function createStorageRouter(options: StorageRouterOptions): StorageRouter {
  const now = options.now ?? Date.now;
  const activeTtlMs = options.activeTtlMs ?? ACTIVE_PROFILE_TTL_MS;
  const maxClients = Math.max(1, options.maxClients ?? DEFAULT_MAX_CLIENTS);
  const factory = options.createStorage ?? createProfileStorage;
  const clients = new Map<string, FileStorage>();
  let active:
    | { expiresAt: number; value: Promise<FileStorageProfile> }
    | undefined;

  const resolveActive = () => {
    const timestamp = now();
    if (active && active.expiresAt > timestamp) return active.value;
    const value = options.repository
      .getActive()
      .then((profile) => profile ?? options.legacyProfile())
      .catch((error) => {
        active = undefined;
        throw error;
      });
    active = { expiresAt: timestamp + activeTtlMs, value };
    return value;
  };

  const resolveProfile = async (profileId?: string) => {
    if (!profileId) return resolveActive();
    if (profileId === LEGACY_STORAGE_PROFILE_ID) return options.legacyProfile();
    const profile = await options.repository.getById(profileId);
    if (!profile) throw new Error(`Storage profile not found: ${profileId}`);
    return profile;
  };

  const resolveStorage = async (profileId?: string) => {
    const profile = await resolveProfile(profileId);
    const cacheKey = `${profile.id}:${profile.version ?? 1}`;
    const cached = clients.get(cacheKey);
    if (cached) {
      clients.delete(cacheKey);
      clients.set(cacheKey, cached);
      return cached;
    }
    const storage = factory(profile);
    clients.set(cacheKey, storage);
    if (clients.size > maxClients) {
      const oldest = clients.keys().next().value as string;
      clients.get(oldest)?.destroy?.();
      clients.delete(oldest);
    }
    return storage;
  };

  const resolveHandle = async (profileId?: string) => {
    const profile = await resolveProfile(profileId);
    return { profile, storage: await resolveStorage(profile.id) };
  };

  const facade = (profileId?: string): FileStorage => ({
    async getProfileId() {
      const profile = await resolveProfile(profileId);
      return profile.id === LEGACY_STORAGE_PROFILE_ID ? undefined : profile.id;
    },
    async upload(content, uploadOptions) {
      const { profile, storage } = await resolveHandle(profileId);
      const result = await storage.upload(content, uploadOptions);
      return {
        ...result,
        storageProfileId: profile.id,
        metadata: { ...result.metadata, storageProfileId: profile.id },
      };
    },
    async createUploadUrl(uploadOptions) {
      const { profile, storage } = await resolveHandle(profileId);
      const result = await storage.createUploadUrl?.(uploadOptions);
      return result ? { ...result, storageProfileId: profile.id } : null;
    },
    async download(key) {
      return (await resolveStorage(profileId)).download(key);
    },
    async delete(key) {
      return (await resolveStorage(profileId)).delete(key);
    },
    async exists(key) {
      return (await resolveStorage(profileId)).exists(key);
    },
    async getMetadata(key) {
      return (await resolveStorage(profileId)).getMetadata(key);
    },
    async getSourceUrl(key) {
      return (await resolveStorage(profileId)).getSourceUrl(key);
    },
    async getDownloadUrl(key) {
      const storage = await resolveStorage(profileId);
      return storage.getDownloadUrl?.(key) ?? null;
    },
  });

  return Object.assign(facade(), {
    withProfile(profileId: string) {
      return facade(profileId);
    },
    async withActive<T>(
      operation: (storage: FileStorage, profile: FileStorageProfile) => Promise<T>,
    ) {
      const profile = await resolveActive();
      return operation(await resolveStorage(profile.id), profile);
    },
  });
}

export function unconfiguredStorageProfile(): FileStorageProfile {
  throw new Error("STORAGE_NOT_CONFIGURED");
}
