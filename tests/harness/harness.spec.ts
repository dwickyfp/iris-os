import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { harnessAuthFile } from "./fixtures";

test.use({ storageState: harnessAuthFile() });

test.describe("Harness browser acceptance", () => {
  test("renders remote connections", async ({ page }) => {
    await page.route("**/api/remote-agents**", (route) =>
      route.fulfill({ json: [] }),
    );
    await page.goto("/remote-agents");
    await expect(
      page.getByRole("heading", { name: "Remote connections" }),
    ).toBeVisible();
    await expect(page.getByText("No remote connections")).toBeVisible();
  });

  test("renders delegation operations", async ({ page }) => {
    await page.route("**/api/agent-runs**", (route) =>
      route.fulfill({
        json: {
          roots: [],
          runs: [],
          delegations: [],
          summary: { active: 0, failed: 0, cancellable: 0 },
        },
      }),
    );
    await page.goto("/delegations");
    await expect(
      page.getByRole("heading", { name: "Delegation tree" }),
    ).toBeVisible();
  });

  test("has no automatically detectable accessibility violations", async ({
    page,
  }) => {
    await page.route("**/api/remote-agents**", (route) =>
      route.fulfill({ json: [] }),
    );
    await page.goto("/remote-agents");
    await expect(
      page.getByRole("heading", { name: "Remote connections" }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include("main.mx-auto")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
