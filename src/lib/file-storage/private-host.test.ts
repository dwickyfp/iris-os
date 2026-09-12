import { describe, expect, it } from "vitest";
import { isPrivateHostname } from "./private-host";

describe("isPrivateHostname", () => {
  it("blocks localhost variants", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("LOCALHOST")).toBe(true);
    expect(isPrivateHostname("localhost.")).toBe(true);
    expect(isPrivateHostname("foo.localhost")).toBe(true);
    expect(isPrivateHostname("foo.local")).toBe(true);
    expect(isPrivateHostname("")).toBe(true);
  });

  it("blocks private IPv4 ranges", () => {
    expect(isPrivateHostname("127.0.0.1")).toBe(true);
    expect(isPrivateHostname("10.1.2.3")).toBe(true);
    expect(isPrivateHostname("172.16.0.1")).toBe(true);
    expect(isPrivateHostname("172.31.255.255")).toBe(true);
    expect(isPrivateHostname("192.168.1.1")).toBe(true);
    expect(isPrivateHostname("169.254.10.10")).toBe(true);
    expect(isPrivateHostname("0.1.2.3")).toBe(true);
  });

  it("allows public IPv4 ranges", () => {
    expect(isPrivateHostname("8.8.8.8")).toBe(false);
    expect(isPrivateHostname("172.32.0.1")).toBe(false);
    expect(isPrivateHostname("100.20.30.40")).toBe(false);
  });

  it("blocks IPv6 loopback", () => {
    expect(isPrivateHostname("::1")).toBe(true);
  });

  it("allows public hostnames", () => {
    expect(isPrivateHostname("example.com")).toBe(false);
    expect(isPrivateHostname("storage.example.com.")).toBe(false);
  });
});
