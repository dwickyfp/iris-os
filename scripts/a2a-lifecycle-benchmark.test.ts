import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { confirmDisposableBenchmarkTarget } = await import(
  "./a2a-lifecycle-benchmark"
);

const proof = {
  connectionString:
    "postgresql://iris:secret@127.0.0.1:49172/iris_a2a_benchmark_a1b2c3d4e5f6",
  database: "iris_a2a_benchmark_a1b2c3d4e5f6",
  marker: "iris-a2a-disposable-a1b2c3d4e5f6",
  token: "a".repeat(64),
  nonce: "b".repeat(48),
};

describe("A2A lifecycle benchmark safety", () => {
  it("requires exact database-side wrapper confirmation", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          current_database: proof.database,
          database_name: proof.database,
          disposable_marker: proof.marker,
          disposable_token: proof.token,
          wrapper_nonce: proof.nonce,
        },
      ],
    });
    await expect(
      confirmDisposableBenchmarkTarget({ query } as never, proof),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });

  it("refuses direct use of the user or app database regardless of name", async () => {
    await expect(
      confirmDisposableBenchmarkTarget({ query: vi.fn() } as never, {
        ...proof,
        applicationDatabaseUrls: [proof.connectionString],
      }),
    ).rejects.toThrow("application database");
  });

  it("refuses mismatched database confirmation", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          current_database: "iris_user_database",
          database_name: proof.database,
          disposable_marker: proof.marker,
          disposable_token: proof.token,
          wrapper_nonce: proof.nonce,
        },
      ],
    });
    await expect(
      confirmDisposableBenchmarkTarget({ query } as never, proof),
    ).rejects.toThrow("confirmation failed");
  });
});
