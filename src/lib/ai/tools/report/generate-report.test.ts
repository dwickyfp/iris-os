import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { ArtifactService } from "../../artifacts";
import { createGenerateReportTool } from "./generate-report";

const artifact = {
  artifactId: randomUUID(),
  storageKey: "reports/revenue.md",
  filename: "revenue.md",
  mediaType: "text/markdown",
  size: 24,
  sha256: createHash("sha256").update("report").digest("hex"),
};

describe("generate_report", () => {
  test("stores Markdown and verifies it before returning success", async () => {
    const create = vi.fn(async () => artifact);
    const verify = vi.fn(async () => ({
      verified: true as const,
      details: { sha256: artifact.sha256 },
    }));
    const report = createGenerateReportTool({
      artifacts: { create } as unknown as ArtifactService,
      verify,
    });

    await expect(
      report.execute?.(
        {
          title: "Revenue",
          markdown: "Revenue increased.",
          filename: "revenue.md",
        },
        {
          toolCallId: "tool-1",
          messages: [],
          context: { userId: "user-1", runId: "run-1" },
        },
      ),
    ).resolves.toEqual({
      artifact,
      verification: {
        verified: true,
        details: { sha256: artifact.sha256 },
      },
    });
    expect(create).toHaveBeenCalledWith({
      content: "# Revenue\n\nRevenue increased.\n",
      filename: "revenue.md",
      mediaType: "text/markdown",
      userId: "user-1",
      runId: "run-1",
    });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedUserId: "user-1",
        expectedRunId: "run-1",
      }),
    );
    expect(create).toHaveBeenCalledBefore(verify);
  });

  test("fails instead of reporting success when verification fails", async () => {
    const report = createGenerateReportTool({
      artifacts: {
        create: vi.fn(async () => artifact),
      } as unknown as ArtifactService,
      verify: vi.fn(async () => ({
        verified: false as const,
        reason: "ARTIFACT_HASH_MISMATCH",
      })),
    });

    await expect(
      report.execute?.(
        {
          title: "Revenue",
          markdown: "Revenue increased.",
          filename: "revenue.md",
        },
        {
          toolCallId: "tool-1",
          messages: [],
          context: { userId: "user-1", runId: "run-1" },
        },
      ),
    ).rejects.toThrow("REPORT_VERIFICATION_FAILED:ARTIFACT_HASH_MISMATCH");
  });

  test("requires runtime user and run identity", async () => {
    const report = createGenerateReportTool({
      artifacts: { create: vi.fn() } as unknown as ArtifactService,
      verify: vi.fn(),
    });

    await expect(
      report.execute?.(
        {
          title: "Revenue",
          markdown: "Revenue increased.",
          filename: "revenue.md",
        },
        { toolCallId: "tool-1", messages: [], context: {} },
      ),
    ).rejects.toThrow("REPORT_RUNTIME_CONTEXT_REQUIRED");
  });
});
