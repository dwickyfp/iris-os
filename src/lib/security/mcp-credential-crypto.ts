import "server-only";

import {
  decryptSystemSettingValue,
  encryptSystemSettingValue,
} from "./encrypted-value";

/**
 * Encryption at rest for MCP credentials: server configs (URLs, auth
 * headers, stdio env vars) and OAuth session data (tokens, client
 * information, PKCE verifiers). Values are stored in JSON/text columns as
 * "ss1..." envelope strings produced by the shared root-key infrastructure;
 * legacy plaintext values are still readable so no data migration is needed.
 */

const CONFIG_SCOPE = "mcp.server.config";
const TOKENS_SCOPE = "mcp.oauth.tokens";
const CLIENT_INFO_SCOPE = "mcp.oauth.client-info";
const CODE_VERIFIER_SCOPE = "mcp.oauth.code-verifier";

const ENVELOPE_PREFIX = "ss1.";

function encryptJson(scope: string, value: unknown): string {
  return encryptSystemSettingValue(
    scope,
    JSON.stringify(value === undefined ? null : value),
  );
}

function decryptJson<T>(scope: string, stored: unknown): T | undefined {
  if (stored === null || stored === undefined) return undefined;
  if (typeof stored !== "string" || !stored.startsWith(ENVELOPE_PREFIX)) {
    // Legacy plaintext row: stored as a JSON object, pass through.
    return stored as T;
  }
  return JSON.parse(decryptSystemSettingValue(scope, stored)) as T;
}

function encryptText(scope: string, value: string): string {
  return encryptSystemSettingValue(scope, value);
}

function decryptText(scope: string, stored: unknown): string | undefined {
  if (stored === null || stored === undefined) return undefined;
  if (typeof stored !== "string" || !stored.startsWith(ENVELOPE_PREFIX)) {
    // Legacy plaintext verifier.
    return stored as string;
  }
  return decryptSystemSettingValue(scope, stored);
}

export function encryptMcpServerConfig(config: unknown): string {
  return encryptJson(CONFIG_SCOPE, config);
}

export function decryptMcpServerConfig<T>(stored: unknown): T | undefined {
  return decryptJson<T>(CONFIG_SCOPE, stored);
}

type OAuthSecrets = {
  clientInfo?: unknown;
  tokens?: unknown;
  codeVerifier?: string | null;
};

/** Encrypts the secret fields of an OAuth session payload before storage. */
export function encryptMcpOAuthSecrets<T extends OAuthSecrets>(
  data: T,
): T & { clientInfo?: string; tokens?: string; codeVerifier?: string } {
  const encrypted: Record<string, unknown> = { ...data };
  if (data.clientInfo !== undefined && data.clientInfo !== null) {
    encrypted.clientInfo = encryptJson(CLIENT_INFO_SCOPE, data.clientInfo);
  }
  if (data.tokens !== undefined && data.tokens !== null) {
    encrypted.tokens = encryptJson(TOKENS_SCOPE, data.tokens);
  }
  if (data.codeVerifier !== undefined && data.codeVerifier !== null) {
    encrypted.codeVerifier = encryptText(
      CODE_VERIFIER_SCOPE,
      data.codeVerifier,
    );
  }
  return encrypted as T & {
    clientInfo?: string;
    tokens?: string;
    codeVerifier?: string;
  };
}

/** Decrypts the secret fields of a stored OAuth session row. */
export function decryptMcpOAuthSecrets<T extends OAuthSecrets>(row: T): T {
  const decrypted: Record<string, unknown> = { ...row };
  if (row.clientInfo !== undefined && row.clientInfo !== null) {
    decrypted.clientInfo = decryptJson(CLIENT_INFO_SCOPE, row.clientInfo);
  }
  if (row.tokens !== undefined && row.tokens !== null) {
    decrypted.tokens = decryptJson(TOKENS_SCOPE, row.tokens);
  }
  if (row.codeVerifier !== undefined && row.codeVerifier !== null) {
    decrypted.codeVerifier = decryptText(CODE_VERIFIER_SCOPE, row.codeVerifier);
  }
  return decrypted as T;
}
