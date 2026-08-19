export type V2FeatureFlags = {
  workspaces: boolean;
  learning: boolean;
  automation: boolean;
  delegation: boolean;
  remoteAgents: boolean;
};

export function getV2FeatureFlags(
  env: Record<string, string | undefined>,
): V2FeatureFlags {
  const enabled = (value: string | undefined) =>
    value === "true" || value === "1";

  return {
    workspaces: enabled(env.IRIS_WORKSPACES_V2),
    learning: enabled(env.IRIS_LEARNING_V2),
    automation: enabled(env.IRIS_AUTOMATION_V2),
    delegation: enabled(env.IRIS_DELEGATION_V2),
    remoteAgents: enabled(env.IRIS_REMOTE_AGENTS_A2A),
  };
}

export function isV2FeatureEnabled(feature: keyof V2FeatureFlags) {
  return getV2FeatureFlags(process.env)[feature];
}
