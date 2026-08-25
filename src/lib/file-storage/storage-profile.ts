import type { FileStorageDriver } from "./file-storage.interface";

export const LEGACY_STORAGE_PROFILE_ID = "__legacy__";

export interface S3StorageProfileConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  prefix?: string;
}

export interface FileStorageProfile {
  id: string;
  name: string;
  driver: FileStorageDriver;
  version?: number;
  s3?: S3StorageProfileConfig;
}

export interface StorageProfileRepository {
  getActive(): Promise<FileStorageProfile | null>;
  getById(profileId: string): Promise<FileStorageProfile | null>;
  listForAdmin(): Promise<
    Array<
      Omit<FileStorageProfile, "s3"> & {
        s3?: Omit<S3StorageProfileConfig, "accessKeyId" | "secretAccessKey">;
        hasCredentials: boolean;
        active: boolean;
      }
    >
  >;
  create(input: {
    id: string;
    name: string;
    driver: FileStorageDriver;
    s3?: S3StorageProfileConfig;
    encryptedAccessKey?: string;
    encryptedSecretKey?: string;
    actorId: string;
  }): Promise<FileStorageProfile>;
  activate(
    profileId: string,
    actorId: string,
    options?: { adoptLegacyObjects?: boolean },
  ): Promise<void>;
}

export function isLegacyStorageProfile(profile: FileStorageProfile): boolean {
  return profile.id === LEGACY_STORAGE_PROFILE_ID;
}
