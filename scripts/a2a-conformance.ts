import { runA2AConformance, runLocalA2AConformance } from "./a2a/conformance";

function valueAfter(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} needs a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--token") || args.includes("--authorization")) {
    throw new Error("Tokens may only be supplied through --token-env");
  }
  const endpoint = valueAfter(args, "--endpoint");
  const tokenEnv = valueAfter(args, "--token-env");
  const known = new Set(["--endpoint", "--token-env"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!known.has(args[index]))
      throw new Error(`Unknown option ${args[index]}`);
  }
  if (!endpoint) {
    if (tokenEnv) throw new Error("--token-env requires --endpoint");
    const reports = await runLocalA2AConformance();
    process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`);
    process.exitCode = reports.every((report) => report.passed) ? 0 : 1;
    return;
  }
  let credential: { type: "bearer"; value: string } | undefined;
  if (tokenEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) {
      throw new Error(
        "--token-env must name an uppercase environment variable",
      );
    }
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`Environment variable ${tokenEnv} is not set`);
    credential = { type: "bearer", value: token };
  }
  const report = await runA2AConformance({ endpoint, credential });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
