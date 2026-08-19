import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAdminPermission, getOperationsDiagnostics } = vi.hoisted(() => ({
  requireAdminPermission: vi.fn(),
  getOperationsDiagnostics: vi.fn(),
}));

vi.mock("lib/auth/permissions", () => ({ requireAdminPermission }));
vi.mock("lib/admin/operations", () => ({ getOperationsDiagnostics }));

import { GET } from "./route";

describe("admin operations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 only when admin authorization fails", async () => {
    requireAdminPermission.mockRejectedValue(new Error("Unauthorized"));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(getOperationsDiagnostics).not.toHaveBeenCalled();
  });

  it("returns 503 when authorized diagnostics are unavailable", async () => {
    requireAdminPermission.mockResolvedValue(undefined);
    getOperationsDiagnostics.mockRejectedValue(new Error("Database down"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Operations diagnostics unavailable",
    });
  });
});
