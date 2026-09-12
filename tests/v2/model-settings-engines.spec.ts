import { expect, test } from "@playwright/test";
import { TEST_USERS } from "../constants/test-users";

test.describe("System model engines", () => {
  test.use({ storageState: TEST_USERS.admin.authFile });

  test("lists every configurable engine and its effective assignment status", async ({
    page,
  }) => {
    const response = await page.request.get(
      "/api/admin/model-settings/engines",
    );
    expect(response.ok()).toBeTruthy();
    const engines = (await response.json()) as Array<{ key: string }>;
    expect(engines.map((engine) => engine.key)).toEqual([
      "memory-curator",
      "automation-runner",
      "delegation-runner",
    ]);

    await page.goto("/admin/models");
    await expect(
      page.getByRole("heading", { name: "System Engines" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Memory Curator" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Memory Embedding" }),
    ).toHaveCount(0);
  });
});

test.describe("System model engine authorization", () => {
  test.use({ storageState: TEST_USERS.editor.authFile });

  test("rejects non-admin engine access", async ({ page }) => {
    const response = await page.request.get(
      "/api/admin/model-settings/engines",
    );
    expect(response.status()).toBe(401);
  });
});
