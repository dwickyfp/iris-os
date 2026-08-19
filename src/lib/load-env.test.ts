import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { load } from "./load-env";

const directory = join(tmpdir(), "iris-load-env-test");
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  delete process.env.IRIS_DISABLE_ENV_FILE_LOADING;
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  rmSync(directory, { recursive: true, force: true });
});

describe("load-env isolation", () => {
  it("does not read env files when a disposable runner disables loading", () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".env"), "OPENAI_API_KEY=poison\n");
    delete process.env.OPENAI_API_KEY;
    process.env.IRIS_DISABLE_ENV_FILE_LOADING = "1";

    expect(load(directory)).toEqual({});
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});
