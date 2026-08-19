import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("canonical AgentRun production invariants", () => {
  test("requires orchestration and a create or claimed run mode in contracts", () => {
    const contracts = source("src/lib/ai/runtime/execution-driver.ts");
    const orchestration = source("src/lib/ai/runtime/contracts.ts");

    expect(contracts).not.toMatch(/orchestration\?: HarnessOrchestration/);
    expect(
      contracts.match(/orchestration: HarnessOrchestration/g),
    ).toHaveLength(2);
    expect(orchestration).toContain('{ mode: "create"; spec: HarnessRunSpec }');
    expect(orchestration).toContain('{ mode: "claimed"; claimToken: string }');
    expect(orchestration).not.toMatch(/\brun\?:/);
  });

  test("chat always creates a durable run independently of delegation", () => {
    const chat = source("src/app/api/chat/route.ts");
    const call = chat.slice(
      chat.indexOf("irisHarness.stream({"),
      chat.indexOf("const result = harnessStream.native"),
    );

    expect(call).toContain('run: {\n              mode: "create"');
    expect(call).not.toContain('isV2FeatureEnabled("delegation")');
  });

  test("production generation paths declare durable ownership", () => {
    const automation = source("src/lib/automation/execution-adapter.ts");
    const resume = source("scripts/workers/parent-resume-worker.ts");

    expect(automation).toContain('mode: "create"');
    expect(automation).toContain('mode: "claimed"');
    expect(automation).toContain("claimToken: input.request.claimToken");
    expect(resume).toContain(
      'run: { mode: "claimed", claimToken: claimed.token }',
    );
  });
});
