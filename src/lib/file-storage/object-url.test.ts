import { describe, expect, it } from "vitest";
import {
  deriveStorageKeyFromUrl,
  guessObjectContentType,
} from "./object-url";
import type { FileStorageProfile } from "./storage-profile";

const pathStyleProfile: FileStorageProfile = {
  id: "p1",
  name: "local-minio",
  driver: "minio",
  version: 1,
  s3: {
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "iris",
  },
};

const publicBaseUrlProfile: FileStorageProfile = {
  ...pathStyleProfile,
  s3: {
    ...pathStyleProfile.s3!,
    endpoint: "http://minio:9000",
    publicBaseUrl: "https://cdn.example.com/assets/",
  },
};

describe("deriveStorageKeyFromUrl", () => {
  it("derives key from path-style endpoint URLs", () => {
    const target = new URL("http://localhost:9000/iris/uploads/u1/a-image.png");
    expect(deriveStorageKeyFromUrl(target, pathStyleProfile)).toBe(
      "uploads/u1/a-image.png",
    );
  });

  it("derives key from publicBaseUrl URLs", () => {
    const target = new URL("https://cdn.example.com/assets/uploads/u1/b.png");
    expect(deriveStorageKeyFromUrl(target, publicBaseUrlProfile)).toBe(
      "uploads/u1/b.png",
    );
  });

  it("derives key from virtual-host style URLs", () => {
    const profile: FileStorageProfile = {
      ...pathStyleProfile,
      s3: { ...pathStyleProfile.s3!, forcePathStyle: false },
    };
    const target = new URL("http://iris.localhost:9000/uploads/u1/c.png");
    expect(deriveStorageKeyFromUrl(target, profile)).toBe("uploads/u1/c.png");
  });

  it("decodes percent-encoded key segments", () => {
    const target = new URL(
      "http://localhost:9000/iris/uploads/u1/some%20file-name.png",
    );
    expect(deriveStorageKeyFromUrl(target, pathStyleProfile)).toBe(
      "uploads/u1/some file-name.png",
    );
  });

  it("returns null for URLs from a different origin", () => {
    const target = new URL("http://evil.example.com/iris/uploads/u1/x.png");
    expect(deriveStorageKeyFromUrl(target, pathStyleProfile)).toBeNull();
  });

  it("returns null for wrong bucket path on matching host", () => {
    const target = new URL("http://localhost:9000/other/uploads/u1/x.png");
    expect(deriveStorageKeyFromUrl(target, pathStyleProfile)).toBeNull();
  });

  it("returns null when profile has no s3 config", () => {
    const profile = {
      id: "p2",
      name: "vercel",
      driver: "vercel-blob",
      version: 1,
    } as unknown as FileStorageProfile;
    const target = new URL("http://localhost:9000/iris/uploads/u1/x.png");
    expect(deriveStorageKeyFromUrl(target, profile)).toBeNull();
  });
});

describe("guessObjectContentType", () => {
  it("prefers stored content type", () => {
    expect(guessObjectContentType("a.png", "image/custom")).toBe(
      "image/custom",
    );
  });

  it("falls back to extension mapping", () => {
    expect(guessObjectContentType("http://x/a-image.PNG")).toBe("image/png");
    expect(guessObjectContentType("doc.pdf")).toBe("application/pdf");
  });

  it("defaults to octet-stream", () => {
    expect(guessObjectContentType("noext")).toBe("application/octet-stream");
  });
});
