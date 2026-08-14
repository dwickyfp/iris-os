import { describe, expect, it } from "vitest";
import { WorkspaceCreateSchema, WorkspaceUpdateSchema } from "./workspace";

describe("WorkspaceCreateSchema", () => {
  it("normalizes a valid owner workspace request", () => {
    expect(
      WorkspaceCreateSchema.parse({
        name: "  IRIS-OS  ",
        slug: "iris-os",
        instructions: "  Use pnpm.  ",
      }),
    ).toEqual({
      name: "IRIS-OS",
      slug: "iris-os",
      instructions: "Use pnpm.",
      defaultToolMode: "auto",
    });
  });

  it("rejects a non-canonical slug", () => {
    expect(() =>
      WorkspaceCreateSchema.parse({ name: "IRIS", slug: "IRIS OS" }),
    ).toThrow();
  });

  it("rejects instructions larger than the trusted-context limit", () => {
    expect(() =>
      WorkspaceCreateSchema.parse({
        name: "IRIS",
        slug: "iris",
        instructions: "x".repeat(20_001),
      }),
    ).toThrow();
  });
});

describe("WorkspaceUpdateSchema", () => {
  it("rejects an update without changes", () => {
    expect(() => WorkspaceUpdateSchema.parse({})).toThrow();
  });
});
