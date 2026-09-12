import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "./config";

let originalEnv: Record<string, string | undefined>;
describe("Auth Config", () => {
  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.unstubAllEnvs();
    delete process.env.DISABLE_EMAIL_SIGN_IN;
    delete process.env.DISABLE_EMAIL_SIGN_UP;
  });

  afterEach(() => {
    process.env = { ...originalEnv } as any;
    vi.unstubAllEnvs();
  });

  describe("getAuthConfig", () => {
    it("should return default config when no environment variables are set", () => {
      const config = getAuthConfig(process.env);

      expect(config).toEqual({
        emailAndPasswordEnabled: true,
        signUpEnabled: true,
      });
    });

    it("should parse DISABLE_EMAIL_SIGN_IN correctly", () => {
      vi.stubEnv("DISABLE_EMAIL_SIGN_IN", "1");

      const config = getAuthConfig(process.env);
      expect(config.emailAndPasswordEnabled).toBe(false);
    });

    it("should parse DISABLE_EMAIL_SIGN_UP correctly", () => {
      vi.stubEnv("DISABLE_EMAIL_SIGN_UP", "1");

      const config = getAuthConfig(process.env);
      expect(config.signUpEnabled).toBe(false);
    });

    it("should parse boolean environment variables with various formats", () => {
      vi.stubEnv("DISABLE_EMAIL_SIGN_IN", "0");
      vi.stubEnv("DISABLE_EMAIL_SIGN_UP", "False");

      const config = getAuthConfig(process.env);
      expect(config.emailAndPasswordEnabled).toBe(true);
      expect(config.signUpEnabled).toBe(true);
    });
  });
});
