import "server-only";
import { pgStorageProfileRepository } from "lib/db/pg/repositories/storage-profile-repository.pg";
import type { FileStorageDriver } from "./file-storage.interface";
import {
  createStorageRouter,
  unconfiguredStorageProfile,
} from "./storage-router";

export const storageDriver: FileStorageDriver = "minio";
export const serverFileStorage = createStorageRouter({
  repository: pgStorageProfileRepository,
  legacyProfile: unconfiguredStorageProfile,
});
export const withProfile = (profileId: string) =>
  serverFileStorage.withProfile(profileId);

export type { FileStorage, FileStorageDriver } from "./file-storage.interface";
export type {
  FileStorageProfile,
  S3StorageProfileConfig,
  StorageProfileRepository,
} from "./storage-profile";
export { LEGACY_STORAGE_PROFILE_ID } from "./storage-profile";
