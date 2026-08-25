import { beforeEach, describe, expect, it, vi } from "vitest";

const { getActive } = vi.hoisted(() => ({ getActive: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("lib/db/pg/repositories/storage-profile-repository.pg", () => ({
  pgStorageProfileRepository: { getActive },
}));

import { checkStorageAction, getStorageInfoAction } from "./actions";

describe("storage settings actions", () => {
  beforeEach(() => getActive.mockReset());

  it("requires an active database profile", async () => {
    getActive.mockResolvedValue(null);
    await expect(checkStorageAction()).resolves.toMatchObject({
      isValid: false,
      error: "No active object storage profile",
    });
  });

  it("reports MinIO without enabling unsafe direct uploads", async () => {
    getActive.mockResolvedValue({ id: "profile-1", driver: "minio" });
    await expect(checkStorageAction()).resolves.toEqual({ isValid: true });
    await expect(getStorageInfoAction()).resolves.toEqual({
      type: "minio",
      supportsDirectUpload: false,
    });
  });
});
