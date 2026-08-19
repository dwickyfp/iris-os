export const HARNESS_USER = {
  email: "editor@harness.invalid",
  password: "HarnessEditor123!",
  name: "Harness Editor",
  role: "editor",
} as const;

export function harnessAuthFile(): string {
  const path = process.env.HARNESS_AUTH_FILE;
  if (!path) throw new Error("HARNESS_AUTH_FILE is required");
  return path;
}
