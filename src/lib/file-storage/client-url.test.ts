import { describe, expect, it } from "vitest";
import { resolveServableFileUrl } from "./client-url";

describe("resolveServableFileUrl", () => {
  it("proxies private storage URLs", () => {
    const url = "http://localhost:9000/iris/uploads/u1/a-image.png";
    expect(resolveServableFileUrl(url)).toBe(
      `/api/storage/file?url=${encodeURIComponent(url)}`,
    );
  });

  it("proxies private IPv4 URLs", () => {
    const url = "http://192.168.1.10:9000/iris/uploads/u1/a-image.png";
    expect(resolveServableFileUrl(url)).toBe(
      `/api/storage/file?url=${encodeURIComponent(url)}`,
    );
  });

  it("leaves public URLs unchanged", () => {
    const url = "https://cdn.example.com/uploads/u1/a-image.png";
    expect(resolveServableFileUrl(url)).toBe(url);
  });

  it("leaves data, blob, and relative URLs unchanged", () => {
    expect(resolveServableFileUrl("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
    expect(resolveServableFileUrl("blob:https://app/123")).toBe(
      "blob:https://app/123",
    );
    expect(resolveServableFileUrl("/api/storage/upload")).toBe(
      "/api/storage/upload",
    );
  });

  it("returns undefined for empty input", () => {
    expect(resolveServableFileUrl(undefined)).toBeUndefined();
    expect(resolveServableFileUrl(null)).toBeUndefined();
  });

  it("returns invalid URLs unchanged", () => {
    expect(resolveServableFileUrl("not a url")).toBe("not a url");
  });
});
