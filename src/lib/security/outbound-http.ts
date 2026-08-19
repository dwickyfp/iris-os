import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 10_000;
export const DEFAULT_OUTBOUND_BODY_BYTES = 1_048_576;
export const DEFAULT_OUTBOUND_REDIRECTS = 3;

type LookupAddress = { address: string; family: number };
type Lookup = (hostname: string) => Promise<LookupAddress[] | LookupAddress>;

export type SecureFetchOptions = {
  fetch?: typeof fetch;
  lookup?: Lookup;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  allowHttp?: boolean;
  allowLoopback?: boolean;
};

const JSON_CONTENT_TYPES = ["application/json", "application/a2a+json"];

function parseIpv4(address: string) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)
    ? parts
    : null;
}

function isBlockedIpv4(address: string) {
  const parts = parseIpv4(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) {
    return true;
  }
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isBlockedIpv4(mapped);
  const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return normalized.startsWith("::");
}

export function isPublicIpAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return !isBlockedIpv4(normalized);
  if (family === 6) return !isBlockedIpv6(normalized);
  return false;
}

export async function validatePublicUrl(
  input: string | URL,
  options: Pick<
    SecureFetchOptions,
    "lookup" | "allowHttp" | "allowLoopback"
  > = {},
) {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (
    url.protocol !== "https:" &&
    !(options.allowHttp && url.protocol === "http:")
  ) {
    throw new Error("Remote agent URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Remote agent URL must not contain credentials");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await (options.lookup ?? ((host) => dnsLookup(host, { all: true })))(
        hostname,
      );
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  const loopbackAllowed =
    options.allowLoopback &&
    addresses.every(({ address }) =>
      ["127.0.0.1", "::1"].includes(address.replace(/^\[|\]$/g, "")),
    );
  if (
    addresses.length === 0 ||
    (!loopbackAllowed &&
      addresses.some(({ address }) => !isPublicIpAddress(address)))
  ) {
    throw new Error("Remote agent URL resolves to a non-public address");
  }
  return { url, addresses };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("Remote response body is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancelOnAbort = () => {
    void reader.cancel(abortReason(signal));
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Remote response body is too large");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function abortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function raceWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function secureJsonFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SecureFetchOptions = {},
): Promise<unknown> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? DEFAULT_OUTBOUND_BODY_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_OUTBOUND_REDIRECTS;
  const deadline = Date.now() + timeoutMs;
  const callerSignal = init.signal;
  const timeoutError = new Error("Remote request timed out");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(abortReason(callerSignal!));
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();
  const timer = setTimeout(
    () => controller.abort(timeoutError),
    Math.max(0, deadline - Date.now()),
  );
  let url = input instanceof URL ? new URL(input) : new URL(input);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const validated = await raceWithSignal(
        validatePublicUrl(url, options),
        controller.signal,
      );
      const dispatcher =
        fetcher === globalThis.fetch
          ? new Agent({
              connect: {
                lookup: (_hostname, lookupOptions, callback) => {
                  const family = Number(lookupOptions.family || 0);
                  const addresses = family
                    ? validated.addresses.filter(
                        (entry) => entry.family === family,
                      )
                    : validated.addresses;
                  const selected = addresses[0];
                  if (!selected) {
                    callback(
                      new Error("No validated DNS address available"),
                      "",
                    );
                    return;
                  }
                  callback(null, selected.address, selected.family);
                },
              },
            })
          : undefined;

      try {
        const response = await raceWithSignal(
          fetcher(url, {
            ...init,
            redirect: "manual",
            signal: controller.signal,
            ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
          }),
          controller.signal,
        );
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (response.body) {
            await raceWithSignal(response.body.cancel(), controller.signal);
          }
          if (redirects >= maxRedirects) throw new Error("Too many redirects");
          const location = response.headers.get("location");
          if (!location) throw new Error("Remote redirect is missing Location");
          const redirectUrl = new URL(location, url);
          if (redirectUrl.origin !== url.origin) {
            throw new Error("Cross-origin remote redirects are not allowed");
          }
          url = redirectUrl;
          continue;
        }
        const text = await raceWithSignal(
          readBoundedBody(response, maxBytes, controller.signal),
          controller.signal,
        );
        if (!response.ok) {
          throw new Error(`Remote request failed with HTTP ${response.status}`);
        }
        const contentType = response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (!contentType || !JSON_CONTENT_TYPES.includes(contentType)) {
          throw new Error("Remote response Content-Type is not JSON");
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new Error("Remote response is not valid JSON");
        }
      } finally {
        if (dispatcher) {
          if (controller.signal.aborted) {
            await dispatcher.destroy();
          } else {
            try {
              await raceWithSignal(dispatcher.close(), controller.signal);
            } catch (error) {
              await dispatcher.destroy();
              throw error;
            }
          }
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
