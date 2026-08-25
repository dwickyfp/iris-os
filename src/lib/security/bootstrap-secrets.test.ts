import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveBootstrapSecret } from "./bootstrap-secrets";

const root = randomBytes(32).toString("base64");

describe("bootstrap secrets", () => {
  it("derives a stable purpose-specific secret", () => {
    const secret = deriveBootstrapSecret(root, "iris-os:better-auth:secret:v1");

    expect(secret).toHaveLength(43);
    expect(secret).toBe(
      deriveBootstrapSecret(root, "iris-os:better-auth:secret:v1"),
    );
    expect(secret).not.toBe(
      deriveBootstrapSecret(root, "iris-os:another-purpose:v1"),
    );
  });

  it("requires a canonical base64-encoded 32-byte root key", () => {
    expect(() =>
      deriveBootstrapSecret(undefined, "iris-os:better-auth:secret:v1"),
    ).toThrow("IRIS_ROOT_ENCRYPTION_KEY is required");
    expect(() =>
      deriveBootstrapSecret("not-a-key", "iris-os:better-auth:secret:v1"),
    ).toThrow("base64-encoded 32-byte key");
  });

  it("requires an explicit purpose", () => {
    expect(() => deriveBootstrapSecret(root, "")).toThrow(
      "Bootstrap secret purpose is required",
    );
  });
});
