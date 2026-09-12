import { describe, expect, it } from "vitest";
import { getV2FeatureFlags } from "./feature-flags";

describe("getV2FeatureFlags", () => {
  it("defaults every V2 subsystem off", () => {
    expect(getV2FeatureFlags({})).toEqual({
      workspaces: false,
      learning: false,
      automation: false,
      delegation: false,
      remoteAgents: false,
      subagents: true,
    });
  });

  it("enables only explicit true values", () => {
    expect(
      getV2FeatureFlags({
        IRIS_WORKSPACES_V2: "true",
        IRIS_LEARNING_V2: "1",
        IRIS_AUTOMATION_V2: "yes",
        IRIS_DELEGATION_V2: "false",
        IRIS_REMOTE_AGENTS_A2A: "true",
      }),
    ).toEqual({
      workspaces: true,
      learning: true,
      automation: false,
      delegation: false,
      remoteAgents: true,
      subagents: true,
    });
  });

  it("keeps subagents on unless explicitly disabled", () => {
    expect(getV2FeatureFlags({ IRIS_SUBAGENTS_V2: "false" }).subagents).toBe(
      false,
    );
    expect(getV2FeatureFlags({ IRIS_SUBAGENTS_V2: "0" }).subagents).toBe(false);
    expect(getV2FeatureFlags({ IRIS_SUBAGENTS_V2: "true" }).subagents).toBe(
      true,
    );
    expect(getV2FeatureFlags({ IRIS_SUBAGENTS_V2: "anything" }).subagents).toBe(
      true,
    );
  });
});
