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
