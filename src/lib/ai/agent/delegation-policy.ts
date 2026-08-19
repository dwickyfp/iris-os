import {
  type PolicyAuthority,
  intersectPolicyAuthority,
} from "../runtime/policy-engine";

export function intersectDelegationPermissions(input: {
  parentTools: string[];
  childTools: string[];
  approvedTools: string[];
}) {
  const child = new Set(input.childTools);
  const approved = new Set(input.approvedTools);
  return [...new Set(input.parentTools)].filter(
    (tool) => child.has(tool) && approved.has(tool),
  );
}

export function intersectDelegationAuthority(input: {
  parentTools: string[];
  childTools: string[];
  approvedTools: string[];
  parentPolicy: PolicyAuthority;
  childPolicy: PolicyAuthority;
}) {
  return {
    allowedTools: intersectDelegationPermissions(input),
    policy: intersectPolicyAuthority(input.parentPolicy, input.childPolicy),
  };
}
