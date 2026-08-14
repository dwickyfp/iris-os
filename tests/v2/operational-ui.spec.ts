import { expect, test } from "@playwright/test";
import { TEST_USERS } from "../constants/test-users";

test.describe("IRIS V2 operational UI", () => {
  test.use({ storageState: TEST_USERS.editor.authFile });

  test("creates, starts, checkpoints, and continues a task", async ({
    page,
  }) => {
    const title = `playwright-v2-task-${Date.now()}`;
    await page.goto("/tasks");
    await expect(
      page.getByRole("heading", { name: "Operational tasks" }),
    ).toBeVisible();
    await page.getByLabel("Task title").fill(title);
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByRole("button", { name: "Block" })).toBeEnabled();
    await page.getByLabel("Checkpoint").fill("UI checkpoint verified");
    await page.getByLabel("Exact next action").fill("Continue via chat");
    await page.getByRole("button", { name: "Save checkpoint" }).click();
    await expect(
      page.getByText("checkpointed", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue work" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("renders automation, delegation, learning, and OS failure states", async ({
    page,
  }) => {
    await page.goto("/automations");
    await expect(
      page.getByRole("heading", { name: "Automations" }),
    ).toBeVisible();
    await expect(page.getByText("No automations configured.")).toBeVisible();

    await page.goto("/delegations");
    await expect(
      page.getByRole("heading", { name: "Delegation tree" }),
    ).toBeVisible();
    await expect(
      page.getByText("No delegated agent runs yet", { exact: false }),
    ).toBeVisible();

    await page.goto("/learning");
    await expect(
      page.getByRole("heading", { name: "Learning inbox" }),
    ).toBeVisible();
    await expect(page.getByText("Learning controls")).toBeVisible();

    await page.goto("/os");
    await expect(page.getByText("Awaiting approval")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open task ledger" }),
    ).toBeVisible();
  });
});
