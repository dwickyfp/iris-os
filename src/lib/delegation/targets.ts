export type DelegationTarget =
  | { kind: "local"; agentId: string; name: string; description?: string }
  | {
      kind: "remote";
      connectionId: string;
      name: string;
      description?: string;
    };

export function delegationTargetId(
  target:
    | Pick<Extract<DelegationTarget, { kind: "local" }>, "kind" | "agentId">
    | Pick<
        Extract<DelegationTarget, { kind: "remote" }>,
        "kind" | "connectionId"
      >,
) {
  return target.kind === "local"
    ? `local:${target.agentId}`
    : `remote:${target.connectionId}`;
}

export function assertDelegationTargetEligible(input: {
  context: Record<string, unknown>;
  target:
    | { kind: "local"; agentId: string }
    | { kind: "remote"; connectionId: string };
  remoteAgentsEnabled: boolean;
}) {
  const eligible = Array.isArray(input.context.eligibleDelegationTargets)
    ? input.context.eligibleDelegationTargets.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (!eligible.includes(delegationTargetId(input.target)))
    throw new Error("DELEGATION_TARGET_NOT_ELIGIBLE");
  if (input.target.kind === "remote" && !input.remoteAgentsEnabled)
    throw new Error("REMOTE_AGENTS_DISABLED");
}
