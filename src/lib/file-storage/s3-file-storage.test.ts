import { S3Client } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientConfigMock, sendMock } = vi.hoisted(() => ({
  clientConfigMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class BaseCommand {
    constructor(public input: unknown) {}
  }
  return {
    S3Client: vi.fn().mockImplementation((config) => {
      clientConfigMock(config);
      return { send: sendMock };
    }),
    PutObjectCommand: class extends BaseCommand {},
    GetObjectCommand: class extends BaseCommand {},
    DeleteObjectCommand: class extends BaseCommand {},
    HeadObjectCommand: class extends BaseCommand {},
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client, _command, { expiresIn }) => {
    return `https://example.com/presigned?exp=${expiresIn}`;
  }),
}));

import {
  type S3FileStorageConfig,
  createS3FileStorage,
} from "./s3-file-storage";

const explicitConfig: S3FileStorageConfig = {
  bucket: "my-bucket",
  region: "us-east-2",
  prefix: "uploads",
};

describe("s3-file-storage", () => {
  beforeEach(() => {
    sendMock.mockReset();
    clientConfigMock.mockReset();
    vi.mocked(S3Client).mockClear();
  });

  it("uses explicit typed configuration and credentials", () => {
    createS3FileStorage({
      ...explicitConfig,
      endpoint: "http://localhost:9000",
      accessKeyId: "minio-user",
      secretAccessKey: "minio-password",
      forcePathStyle: true,
    });

    expect(clientConfigMock).toHaveBeenCalledWith({
      region: "us-east-2",
      endpoint: "http://localhost:9000",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "minio-user",
        secretAccessKey: "minio-password",
      },
    });
  });

  it("uses injected clients without constructing an S3 client", async () => {
    const injectedSend = vi.fn().mockResolvedValue({});
    const client = {
      send: injectedSend,
    } as unknown as S3Client;
    const storage = createS3FileStorage({ ...explicitConfig, client });

    expect(await storage.exists("uploads/a.txt")).toBe(true);
    expect(injectedSend).toHaveBeenCalledOnce();
    expect(S3Client).not.toHaveBeenCalled();
  });

  it("passes SDK configuration to an injected client factory", () => {
    const client = { send: vi.fn() } as unknown as S3Client;
    const clientFactory = vi.fn(() => client);

    createS3FileStorage({ ...explicitConfig, clientFactory });

    expect(clientFactory).toHaveBeenCalledWith({
      region: "us-east-2",
      endpoint: undefined,
      forcePathStyle: false,
      credentials: undefined,
    });
  });

  it("uses an injected presigner", async () => {
    const presigner = vi.fn(async () => "https://minio.test/signed");
    const storage = createS3FileStorage({ ...explicitConfig, presigner });
    const result = await storage.createUploadUrl!({
      filename: "img.png",
      contentType: "image/png",
      expiresInSeconds: 600,
    });

    expect(result?.url).toBe("https://minio.test/signed");
    expect(result?.method).toBe("PUT");
    expect(result?.headers).toEqual({ "Content-Type": "image/png" });
    expect(presigner).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { expiresIn: 600 },
    );
  });

  it("builds path-style MinIO URLs and encodes individual key segments", async () => {
    const storage = createS3FileStorage({
      ...explicitConfig,
      endpoint: "http://localhost:9000/",
      forcePathStyle: true,
    });

    await expect(storage.getSourceUrl("folder/a #?%+!'()*b.txt")).resolves.toBe(
      "http://localhost:9000/my-bucket/folder/a%20%23%3F%25%2B%21%27%28%29%2Ab.txt",
    );
  });

  it("joins encoded keys to a configured public base URL", async () => {
    const storage = createS3FileStorage({
      ...explicitConfig,
      publicBaseUrl: "https://cdn.example.com/assets/",
    });

    await expect(storage.getSourceUrl("folder/a b.txt")).resolves.toBe(
      "https://cdn.example.com/assets/folder/a%20b.txt",
    );
  });

  it("returns false from exists only for 404 responses", async () => {
    const storage = createS3FileStorage(explicitConfig);
    const notFound = Object.assign(new Error("not found"), {
      $metadata: { httpStatusCode: 404 },
    });
    sendMock.mockRejectedValueOnce(notFound);

    await expect(storage.exists("uploads/missing.txt")).resolves.toBe(false);

    const outage = Object.assign(new Error("service unavailable"), {
      $metadata: { httpStatusCode: 503 },
    });
    sendMock.mockRejectedValueOnce(outage);
    await expect(storage.exists("uploads/a.txt")).rejects.toBe(outage);
  });

  it("maps object metadata", async () => {
    const storage = createS3FileStorage(explicitConfig);
    sendMock.mockResolvedValueOnce({
      ContentType: "text/plain",
      ContentLength: 10,
      LastModified: new Date("2020-01-01"),
    });

    const metadata = await storage.getMetadata("uploads/x.txt");
    expect(metadata?.contentType).toBe("text/plain");
    expect(metadata?.size).toBe(10);
  });

  it("rejects partial explicit credentials", () => {
    expect(() =>
      createS3FileStorage({
        ...explicitConfig,
        accessKeyId: "missing-secret",
      }),
    ).toThrow("accessKeyId and secretAccessKey must be provided together");
  });
});
