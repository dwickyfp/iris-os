import { describe, expect, it, vi } from "vitest";
import type { FileStorage } from "./file-storage.interface";
import { createProfileStorage, createStorageRouter } from "./storage-router";
import {
  LEGACY_STORAGE_PROFILE_ID,
  type FileStorageProfile,
  type StorageProfileRepository,
} from "./storage-profile";

const profile = (id: string, driver: FileStorageProfile["driver"] = "s3") =>
  ({
    id,
    name: id,
    driver,
    s3: { bucket: id, region: "us-east-1" },
  }) satisfies FileStorageProfile;

const storage = (id: string): FileStorage => ({
  upload: vi.fn(async () => ({
    key: id,
    sourceUrl: id,
    metadata: { key: id, filename: id, contentType: "text/plain", size: 1 },
  })),
  download: vi.fn(async () => Buffer.from(id)),
  delete: vi.fn(async () => {}),
  exists: vi.fn(async () => true),
  getMetadata: vi.fn(async () => null),
  getSourceUrl: vi.fn(async () => id),
});

function setup(options: {
  active?: FileStorageProfile | null;
  profiles?: FileStorageProfile[];
  now?: () => number;
  maxClients?: number;
}) {
  const repository: StorageProfileRepository = {
    getActive: vi.fn(async () => options.active ?? null),
    getById: vi.fn(async (id) =>
      options.profiles?.find((item) => item.id === id) ?? null,
    ),
    listForAdmin: vi.fn(async () => []),
    create: vi.fn(async (input) => ({
      id: input.id,
      name: input.name,
      driver: input.driver,
      s3: input.s3,
    })),
    activate: vi.fn(async () => undefined),
  };
  const createStorage = vi.fn((item: FileStorageProfile) => storage(item.id));
  const router = createStorageRouter({
    repository,
    createStorage,
    now: options.now,
    maxClients: options.maxClients,
    legacyProfile: () => profile(LEGACY_STORAGE_PROFILE_ID, "vercel-blob"),
  });
  return { router, repository, createStorage };
}

describe("storage router", () => {
  it("resolves the active profile asynchronously and creates its client lazily", async () => {
    const { router, repository, createStorage } = setup({ active: profile("a") });
    expect(createStorage).not.toHaveBeenCalled();
    await expect(router.getSourceUrl("key")).resolves.toBe("a");
    expect(repository.getActive).toHaveBeenCalledOnce();
    expect(createStorage).toHaveBeenCalledOnce();
  });

  it("routes withProfile directly without resolving the active profile", async () => {
    const { router, repository } = setup({ profiles: [profile("b")] });
    await expect(router.withProfile("b").download("key")).resolves.toEqual(
      Buffer.from("b"),
    );
    expect(repository.getActive).not.toHaveBeenCalled();
    expect(repository.getById).toHaveBeenCalledWith("b");
  });

  it("caches active resolution for two seconds", async () => {
    let timestamp = 0;
    const { router, repository } = setup({
      active: profile("a"),
      now: () => timestamp,
    });
    await router.exists("one");
    timestamp = 1_999;
    await router.exists("two");
    timestamp = 2_000;
    await router.exists("three");
    expect(repository.getActive).toHaveBeenCalledTimes(2);
  });

  it("uses a bounded least-recently-used client cache", async () => {
    const profiles = [profile("a"), profile("b"), profile("c")];
    const { router, createStorage } = setup({ profiles, maxClients: 2 });
    await router.withProfile("a").exists("key");
    await router.withProfile("b").exists("key");
    await router.withProfile("a").exists("key");
    await router.withProfile("c").exists("key");
    await router.withProfile("b").exists("key");
    expect(createStorage).toHaveBeenCalledTimes(4);
  });

  it("uses the virtual legacy profile when no active profile exists", async () => {
    const { router, createStorage } = setup({ active: null });
    await router.exists("key");
    expect(createStorage).toHaveBeenCalledWith(
      expect.objectContaining({ id: LEGACY_STORAGE_PROFILE_ID }),
    );
  });

  it("does not cache a failed active lookup", async () => {
    const { router, repository } = setup({ active: profile("a") });
    vi.mocked(repository.getActive)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(profile("a"));

    await expect(router.exists("key")).rejects.toThrow("database unavailable");
    await expect(router.exists("key")).resolves.toBe(true);
    expect(repository.getActive).toHaveBeenCalledTimes(2);
  });

  it("does not use legacy fallback for a missing explicit profile", async () => {
    const { router } = setup({});
    await expect(router.withProfile("missing").exists("key")).rejects.toThrow(
      "Storage profile not found: missing",
    );
  });

  it("maps MinIO to explicit path-style S3 configuration", async () => {
    const minio: FileStorageProfile = {
      ...profile("minio", "minio"),
      s3: {
      bucket: "files",
      endpoint: "http://localhost:9000",
      forcePathStyle: false,
      region: "us-east-1",
      },
    };

    await expect(
      createProfileStorage(minio).getSourceUrl("folder/a.txt"),
    ).resolves.toBe("http://localhost:9000/files/folder/a.txt");
  });
});
