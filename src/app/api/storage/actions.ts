"use server";

import { storageDriver } from "lib/file-storage";
import { pgStorageProfileRepository } from "lib/db/pg/repositories/storage-profile-repository.pg";

/**
 * Get storage configuration info.
 * Used by clients to determine upload strategy.
 */
export async function getStorageInfoAction() {
  const active = await pgStorageProfileRepository.getActive();
  const type = active?.driver ?? storageDriver;
  return {
    type,
    supportsDirectUpload: false,
  };
}

interface StorageCheckResult {
  isValid: boolean;
  error?: string;
  solution?: string;
}

/**
 * Check if storage is properly configured.
 * Returns detailed error messages with solutions.
 */
export async function checkStorageAction(): Promise<StorageCheckResult> {
  const active = await pgStorageProfileRepository.getActive();
  return active
    ? { isValid: true }
    : {
        isValid: false,
        error: "No active object storage profile",
        solution: "Create, test, and activate a profile in Admin > Settings.",
      };
}
