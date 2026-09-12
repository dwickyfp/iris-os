import { expect, test } from "@playwright/test";
import { TEST_USERS } from "../constants/test-users";

/**
 * Core chat streaming flow: send a message and consume a streamed response.
 * The /api/chat endpoint is mocked with a valid UI message stream so the
 * spec exercises the client streaming path without a model provider.
 */

const SSE_HEADERS = { "Content-Type": "text/event-stream" };

function uiMessageStream(deltas: string[]) {
  const events: unknown[] = [
    { type: "start" },
    { type: "start-step" },
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    { type: "finish-step" },
    { type: "finish" },
  ];
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return `${body}data: [DONE]\n\n`;
}

test.describe("Chat streaming", () => {
  test("streams an assistant response into the thread", async ({ page }) => {
    await page.goto("/sign-in");
    await page.locator("#email").fill(TEST_USERS.admin.email);
    await page.locator("#password").fill(TEST_USERS.admin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.toString().includes("/sign-in"), {
      timeout: 10_000,
    });

    await page.route("**/api/chat", async (route) =>
      route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: uiMessageStream(["Hello ", "from ", "the ", "mock ", "stream!"]),
      }),
    );

    await page.goto("/");
    const composer = page
      .getByRole("textbox")
      .filter({ hasNot: page.getByRole("searchbox") })
      .first();
    await composer.fill("Hello there");
    await composer.press("Enter");

    await expect(
      page.getByText("Hello from the mock stream!", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Hello there")).toBeVisible();
  });

  test("surfaces a stream error with a retry affordance", async ({ page }) => {
    await page.goto("/sign-in");
    await page.locator("#email").fill(TEST_USERS.admin.email);
    await page.locator("#password").fill(TEST_USERS.admin.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.toString().includes("/sign-in"), {
      timeout: 10_000,
    });

    await page.route("**/api/chat", (route) =>
      route.fulfill({ status: 500, body: "provider exploded" }),
    );

    await page.goto("/");
    const composer = page
      .getByRole("textbox")
      .filter({ hasNot: page.getByRole("searchbox") })
      .first();
    await composer.fill("This will fail");
    await composer.press("Enter");

    await expect(
      page.getByText("This message was not saved", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
