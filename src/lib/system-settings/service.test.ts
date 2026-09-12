import type { SystemSettingMutation } from "app-types/system-settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const encrypt = vi.fn(() => "ss1.root-v1.encrypted");
const decrypt = vi.fn(() => JSON.stringify("decrypted-secret"));
vi.mock("lib/security/encrypted-value", () => ({
  encryptSystemSettingValue: encrypt,
  decryptSystemSettingValue: decrypt,
}));

const { createSystemSettingsService, SystemSettingRevisionConflictError } =
  await import("./service");

function stored(overrides: Record<string, unknown> = {}) {
  return {
    key: "memory.curatorMode" as const,
    valueKind: "plain" as const,
    value: "write" as const,
    encryptedValue: null,
    encryptionKeyId: null,
    revision: 2,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    rotatedAt: null,
    ...overrides,
  };
}

function repository(rows: ReturnType<typeof stored>[] = [stored()]) {
  return {
    list: vi.fn(async () => rows),
    selectByKey: vi.fn(async () => rows[0] ?? null),
    mutate: vi.fn<
      () => Promise<{
        setting: ReturnType<typeof stored> | null;
        revision: number;
      } | null>
    >(async () => ({ setting: rows[0] ?? null, revision: 3 })),
    listAudit: vi.fn(async () => []),
  };
}

describe("system settings service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists every definition with defaults and redacts configured secrets", async () => {
    const repo = repository([
      stored(),
      stored({
        key: "exa.apiKey",
        valueKind: "secret",
        value: null,
        encryptedValue: "ciphertext",
      }),
    ]);
    const settings = await createSystemSettingsService(repo).list();

    expect(
      settings.find(({ key }) => key === "memory.curatorMode"),
    ).toMatchObject({ value: "write", configured: true, revision: 2 });
    expect(settings.find(({ key }) => key === "exa.apiKey")).toMatchObject({
      value: null,
      configured: true,
      redacted: true,
      revision: 2,
    });
    expect(settings.find(({ key }) => key === "exa.baseUrl")).toMatchObject({
      value: "https://api.exa.ai",
      configured: false,
      revision: 0,
    });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("reads plain defaults and decrypts secrets only through getSecret", async () => {
    const empty = repository([]);
    await expect(
      createSystemSettingsService(empty).getPlain("exa.baseUrl"),
    ).resolves.toBe("https://api.exa.ai");

    const secret = repository([
      stored({
        key: "exa.apiKey",
        valueKind: "secret",
        value: null,
        encryptedValue: "ciphertext",
      }),
    ]);
    await expect(
      createSystemSettingsService(secret).getSecret("exa.apiKey"),
    ).resolves.toBe("decrypted-secret");
    expect(decrypt).toHaveBeenCalledOnce();
  });

  it("does not read runtime settings from environment variables", async () => {
    const repo = repository([]);
    vi.stubEnv("EXA_API_KEY", "environment-secret");
    vi.stubEnv("DISABLE_EMAIL_SIGN_IN", "1");
    const service = createSystemSettingsService(repo);

    await expect(service.getSecret("exa.apiKey")).resolves.toBeNull();
    await expect(service.getPlain("auth.emailSignInEnabled")).resolves.toBe(
      true,
    );
    vi.stubEnv("EXA_API_KEY", "rotated-environment-secret");
    await expect(service.getSecret("exa.apiKey")).resolves.toBeNull();
    vi.unstubAllEnvs();
  });

  it("validates and encrypts secret mutations without persisting plaintext", async () => {
    const row = stored({
      key: "exa.apiKey",
      valueKind: "secret",
      value: null,
      encryptedValue: "ss1.root-v1.encrypted",
      revision: 1,
    });
    const repo = repository([row]);
    repo.mutate.mockResolvedValue({ setting: row, revision: 1 });
    const result = await createSystemSettingsService(repo).mutate(
      { operation: "set", key: "exa.apiKey", value: "new-secret" },
      "admin-1",
      0,
    );

    expect(encrypt).toHaveBeenCalledWith(
      "exa.apiKey",
      JSON.stringify("new-secret"),
    );
    expect(repo.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        value: null,
        encryptedValue: "ss1.root-v1.encrypted",
        encryptionKeyId: "root-v1",
        actorId: "admin-1",
        expectedRevision: 0,
      }),
    );
    expect(result).toMatchObject({ value: null, redacted: true, revision: 1 });
  });

  it("reports optimistic revision conflicts", async () => {
    const repo = repository();
    repo.mutate.mockResolvedValue(null);
    await expect(
      createSystemSettingsService(repo).mutate(
        {
          operation: "set",
          key: "memory.curatorMode",
          value: "shadow",
        },
        "admin-1",
        1,
      ),
    ).rejects.toBeInstanceOf(SystemSettingRevisionConflictError);
  });

  it("clears through the same audited mutation contract", async () => {
    const repo = repository();
    repo.mutate.mockResolvedValue({ setting: null, revision: 3 });
    const mutation: SystemSettingMutation = {
      operation: "clear",
      key: "memory.curatorMode",
    };
    await expect(
      createSystemSettingsService(repo).mutate(mutation, "admin-1", 2),
    ).resolves.toMatchObject({
      configured: false,
      value: "shadow",
      revision: 3,
    });
  });
});
