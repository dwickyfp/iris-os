import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";
import { HARNESS_USER, harnessAuthFile } from "./fixtures";

setup("create isolated Harness auth state", async ({ page }) => {
  const authFile = harnessAuthFile();
  await mkdir(dirname(authFile), { recursive: true });
  await page.goto("/sign-in");
  await page.locator("#email").fill(HARNESS_USER.email);
  await page.locator("#password").fill(HARNESS_USER.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  await page.context().storageState({ path: authFile });
});
