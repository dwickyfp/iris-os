export type V2FeatureFlags = {
  workspaces: boolean;
  learning: boolean;
  automation: boolean;
  delegation: boolean;
  remoteAgents: boolean;
  /** Subagent spawning in chat. Enabled unless explicitly disabled. */
  subagents: boolean;
  /**
   * Scoped virtual filesystem tool for agents (workspace_fs). Enabled unless
   * explicitly disabled. File operations only — no code execution.
   */
  workspaceFs: boolean;
};

export function getV2FeatureFlags(
  env: Record<string, string | undefined>,
): V2FeatureFlags {
  const enabled = (value: string | undefined) =>
    value === "true" || value === "1";
  const disabled = (value: string | undefined) =>
    value === "false" || value === "0";

  return {
    workspaces: enabled(env.IRIS_WORKSPACES_V2),
    learning: enabled(env.IRIS_LEARNING_V2),
    automation: enabled(env.IRIS_AUTOMATION_V2),
    delegation: enabled(env.IRIS_DELEGATION_V2),
    remoteAgents: enabled(env.IRIS_REMOTE_AGENTS_A2A),
    subagents: !disabled(env.IRIS_SUBAGENTS_V2),
    workspaceFs: !disabled(env.IRIS_WORKSPACE_FS_V2),
  };
}

export function isV2FeatureEnabled(feature: keyof V2FeatureFlags) {
  return getV2FeatureFlags(process.env)[feature];
}
