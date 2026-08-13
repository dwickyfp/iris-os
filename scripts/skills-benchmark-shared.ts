import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SkillEvalFixtureSchema,
  type SkillEvalFixture,
} from "../src/lib/ai/skill/evaluation";

export const reportDirectory = join(process.cwd(), "artifacts", "skills");

export async function loadSkillEvalFixture(): Promise<SkillEvalFixture> {
  const path = join(process.cwd(), "scripts", "fixtures", "skills-eval.json");
  return SkillEvalFixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeSkillReport(name: string, report: unknown) {
  await mkdir(reportDirectory, { recursive: true });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const timestampedPath = join(reportDirectory, `${name}-${timestamp}.json`);
  const latestPath = join(reportDirectory, `latest-${name}.json`);
  await writeFile(timestampedPath, serialized, { mode: 0o600 });
  await writeFile(latestPath, serialized, { mode: 0o600 });
  return timestampedPath;
}

export async function readLatestSkillReport<T>(name: string): Promise<T> {
  const path = join(reportDirectory, `latest-${name}.json`);
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function skip(message: string) {
  console.log(`SKIP: ${message}`);
}
