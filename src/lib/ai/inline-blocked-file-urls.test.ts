import { describe, expect, it, vi } from "vitest";

vi.mock("lib/file-storage", () => ({
  serverFileStorage: {
    withActive: vi.fn(),
  },
}));

import { inlineBlockedFileUrls } from "./inline-blocked-file-urls";
import { serverFileStorage } from "lib/file-storage";

const minioUrl = "http://localhost:9000/iris/uploads/u1/a-image.png";
const publicUrl = "https://cdn.example.com/uploads/u1/b-image.png";

function mockWithActive(
  implementation: (
    operation: (storage: unknown, profile: unknown) => Promise<unknown>,
  ) => Promise<unknown>,
) {
  vi.mocked(serverFileStorage.withActive).mockImplementation(
    implementation as any,
  );
}

function messageWithFileUrl(url: string) {
  return {
    id: "m1",
    role: "user" as const,
    parts: [
      { type: "file", url, mediaType: "image/png", filename: "a-image.png" },
      { type: "text", text: "ini apa?" },
    ],
  } as any;
}

describe("inlineBlockedFileUrls", () => {
  it("inlines storage URLs as data URLs using server storage credentials", async () => {
    mockWithActive(async (operation) =>
      operation(
        {
          download: vi.fn().mockResolvedValue(Buffer.from("pngbytes")),
          getMetadata: vi.fn().mockResolvedValue({ contentType: "image/png" }),
        },
        {
          id: "p1",
          driver: "minio",
          s3: { endpoint: "http://localhost:9000", bucket: "iris" },
        },
      ),
    );

    const [result] = await inlineBlockedFileUrls([
      messageWithFileUrl(minioUrl),
    ]);
    const filePart = result.parts[0] as any;
    expect(filePart.url).toBe("data:image/png;base64,cG5nYnl0ZXM=");
    // Other parts are untouched
    expect(result.parts[1]).toEqual({ type: "text", text: "ini apa?" });
  });

  it("falls back to a plain fetch when the URL is not from active storage", async () => {
    mockWithActive(async (operation) => operation({}, { id: "p1" }));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from("fallback"), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [result] = await inlineBlockedFileUrls([
      messageWithFileUrl(minioUrl),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(minioUrl);
    expect((result.parts[0] as any).url).toBe(
      "data:image/png;base64,ZmFsbGJhY2s=",
    );

    vi.unstubAllGlobals();
  });

  it("leaves the part unchanged when both download attempts fail", async () => {
    mockWithActive(async () => {
      throw new Error("STORAGE_NOT_CONFIGURED");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 })),
    );

    const original = messageWithFileUrl(minioUrl);
    const [result] = await inlineBlockedFileUrls([original]);
    expect((result.parts[0] as any).url).toBe(minioUrl);

    vi.unstubAllGlobals();
  });

  it("leaves public URLs unchanged without touching storage", async () => {
    const withActive = vi.fn();
    mockWithActive(withActive);

    const [result] = await inlineBlockedFileUrls([
      messageWithFileUrl(publicUrl),
    ]);
    expect((result.parts[0] as any).url).toBe(publicUrl);
    expect(withActive).not.toHaveBeenCalled();
  });
});
