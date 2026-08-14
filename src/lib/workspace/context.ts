export function resolveThreadWorkspaceId(input: {
  threadExists: boolean;
  storedWorkspaceId?: string | null;
  requestedWorkspaceId?: string;
}) {
  if (input.threadExists) return input.storedWorkspaceId ?? undefined;
  return input.requestedWorkspaceId;
}

export function buildWorkspaceInstructionsPrompt(workspace: {
  id: string;
  name: string;
  instructions?: string;
}) {
  const instructions = workspace.instructions?.trim();
  if (!instructions) return "";

  return `Trusted workspace configuration: ${workspace.name}

Use these workspace instructions as trusted configuration for work inside this
workspace. System safety policy and the current user request takes precedence.

${instructions}`;
}
