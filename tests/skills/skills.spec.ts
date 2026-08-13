import { type Page, type Response, expect, test } from "@playwright/test";
import { TEST_USERS } from "../constants/test-users";

const suffix = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;
const skillName = `playwright-skill-${suffix}`;
const updatedSkillName = `${skillName}-updated`;
const agentName = `playwright-skill-agent-${suffix}`;
const description = "Deterministic Playwright skill coverage";
const initialBody = "# Instructions\n\nUse the supporting checklist.";
const updatedBody = "# Updated instructions\n\nUse the revised checklist.";
const filePath = "references/checklist.md";
const fileContent = "- verify input\n- return a concise result";

let skillId: string;
let agentId: string | undefined;

async function expectSuccessfulResponse(responsePromise: Promise<Response>) {
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  return response;
}

async function skillCard(page: Page, name: string) {
  const card = page.getByTestId("skill-card").filter({
    has: page.getByTestId("skill-card-name").filter({ hasText: name }),
  });
  await expect(card).toHaveCount(1);
  return card;
}

test.describe.configure({ mode: "serial" });

test.describe("Skills", () => {
  test.use({ storageState: TEST_USERS.editor.authFile });

  test.afterAll(async ({ browser }) => {
    if (!agentId) return;
    const context = await browser.newContext({
      storageState: TEST_USERS.editor.authFile,
    });
    await context.request.put(`/api/agent/${agentId}/skills`, {
      data: { skillIds: [] },
    });
    await context.request.delete(`/api/agent/${agentId}`);
    await context.close();
  });

  test("navigates to Skills and creates a skill with a supporting text file", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Skills", exact: true }).click();
    await expect(page).toHaveURL(/\/skills$/);
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();

    await page.getByRole("link", { name: "New skill", exact: true }).click();
    await expect(page).toHaveURL(/\/skill\/new$/);

    await page.getByLabel("Name", { exact: true }).fill(skillName);
    await page.getByLabel("Description", { exact: true }).fill(description);
    await page.getByLabel("SKILL.md body").fill(initialBody);
    await page.getByRole("button", { name: "Add file" }).click();
    await page.getByLabel("Path").fill(filePath);
    await page.getByLabel("Path").press("Tab");
    await page.getByLabel(`${filePath} content`).fill(fileContent);

    const createResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/skill") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expectSuccessfulResponse(createResponse);
    await expect(page).toHaveURL(/\/skills$/);

    const card = await skillCard(page, skillName);
    skillId = (await card.getAttribute("data-item-id")) ?? "";
    expect(skillId).not.toBe("");
  });

  test("lists, opens, and edits skill instructions and its text file", async ({
    page,
  }) => {
    await page.goto("/skills");
    const card = await skillCard(page, skillName);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/skill/${skillId}$`));

    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      skillName,
    );
    await expect(page.getByLabel(`${filePath} content`)).toHaveValue(
      fileContent,
    );
    await page.getByLabel("Name", { exact: true }).fill(updatedSkillName);
    await page.getByLabel("SKILL.md body").fill(updatedBody);
    await page
      .getByLabel(`${filePath} content`)
      .fill(`${fileContent}\n- record the outcome`);

    const updateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/skill/${skillId}`) &&
        response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expectSuccessfulResponse(updateResponse);
    await expect(page).toHaveURL(/\/skills$/);
    await skillCard(page, updatedSkillName);

    const response = await page.request.get(`/api/skill/${skillId}`);
    expect(response.ok(), await response.text()).toBe(true);
    const saved = await response.json();
    expect(saved).toMatchObject({ name: updatedSkillName, body: updatedBody });
    expect(saved.files).toContainEqual(
      expect.objectContaining({
        path: filePath,
        content: `${fileContent}\n- record the outcome`,
      }),
    );
  });

  test("keeps a private skill inaccessible to another authenticated user", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: TEST_USERS.editor2.authFile,
    });
    const page = await context.newPage();
    try {
      const response = await page.request.get(`/api/skill/${skillId}`);
      expect(response.status()).toBe(404);

      await page.goto("/skills");
      await expect(
        page.getByTestId("skill-card-name").filter({
          hasText: updatedSkillName,
        }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("shares a readonly skill that another user can view and bookmark", async ({
    page,
    browser,
  }) => {
    await page.goto(`/skill/${skillId}`);
    await page.getByTestId("visibility-button").click();
    const visibilityResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/skill/${skillId}`) &&
        response.request().method() === "PUT",
    );
    await page.getByTestId("visibility-readonly").click();
    await expectSuccessfulResponse(visibilityResponse);

    const context = await browser.newContext({
      storageState: TEST_USERS.editor2.authFile,
    });
    const sharedPage = await context.newPage();
    try {
      await sharedPage.goto("/skills");
      const card = await skillCard(sharedPage, updatedSkillName);

      const bookmarkResponse = sharedPage.waitForResponse(
        (response) =>
          response.url().endsWith("/api/bookmark") &&
          response.request().method() === "POST",
      );
      await card.getByTestId("bookmark-button").click();
      await expectSuccessfulResponse(bookmarkResponse);

      const bookmarked = await sharedPage.request.get(
        "/api/skill?type=bookmarked",
      );
      expect(bookmarked.ok(), await bookmarked.text()).toBe(true);
      expect(await bookmarked.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: skillId })]),
      );

      await card.click();
      await expect(sharedPage).toHaveURL(new RegExp(`/skill/${skillId}$`));
      await expect(
        sharedPage.getByLabel("Name", { exact: true }),
      ).toBeDisabled();
      await expect(sharedPage.getByText("Updated instructions")).toBeVisible();
      await expect(sharedPage.getByLabel(`${filePath} content`)).toBeDisabled();
      await expect(
        sharedPage.getByRole("button", { name: "Save", exact: true }),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("assigns the skill to an agent and reflects it in the assignment UI", async ({
    page,
  }) => {
    const userResponse = await page.request.get("/api/user/details");
    expect(userResponse.ok(), await userResponse.text()).toBe(true);
    const user = await userResponse.json();
    const agentResponse = await page.request.post("/api/agent", {
      data: {
        name: agentName,
        description: "Agent used for skill assignment E2E coverage",
        instructions: {},
        visibility: "private",
        userId: user.id,
      },
    });
    expect(agentResponse.ok(), await agentResponse.text()).toBe(true);
    agentId = (await agentResponse.json()).id;

    const assignmentResponse = await page.request.put(
      `/api/agent/${agentId}/skills`,
      { data: { skillIds: [skillId] } },
    );
    expect(assignmentResponse.ok(), await assignmentResponse.text()).toBe(true);

    const assignedResponse = await page.request.get(
      `/api/agent/${agentId}/skills`,
    );
    expect(assignedResponse.ok(), await assignedResponse.text()).toBe(true);
    expect(await assignedResponse.json()).toEqual([
      expect.objectContaining({ id: skillId, position: 0 }),
    ]);

    await page.goto(`/agent/${agentId}`);
    const skillsSection = page
      .getByText("Skills", { exact: true })
      .locator("..");
    await expect(
      skillsSection.getByText(/Skills provide reusable/),
    ).toBeVisible();
    await expect(skillsSection.getByRole("button").last()).toContainText(
      "1 skill selected",
    );
  });

  test("does not offer skills as direct chat mentions", async ({ page }) => {
    await page.goto("/");
    const editor = page.locator('[contenteditable="true"]').last();
    await expect(editor).toBeVisible();
    await editor.fill(`@${updatedSkillName}`);

    // Skills are activated through agent assignment, not the chat mention picker.
    await expect(page.getByText(updatedSkillName, { exact: true })).toHaveCount(
      0,
    );
  });
});
