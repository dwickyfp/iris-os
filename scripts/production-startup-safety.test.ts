import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production startup migration safety", () => {
  it("keeps install, instrumentation, build, and app startup migration-free", async () => {
    const [instrumentation, postinstall, packageRaw] = await Promise.all([
      readFile("src/instrumentation.ts", "utf8"),
      readFile("scripts/postinstall.ts", "utf8"),
      readFile("package.json", "utf8"),
    ]);
    const packageJson = JSON.parse(packageRaw) as {
      scripts: Record<string, string>;
    };
    const forbidden = /runMigrate|db:migrate|migrate\.pg|drizzle-orm\/.*migrator/;

    expect(instrumentation).not.toMatch(forbidden);
    expect(postinstall).not.toMatch(forbidden);
    for (const script of ["postinstall", "build", "start"]) {
      expect(packageJson.scripts[script]).not.toMatch(forbidden);
    }
    expect(packageJson.scripts["db:migrate"]).toBe("tsx scripts/db-migrate.ts");
  });
});
