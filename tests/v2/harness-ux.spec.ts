import { expect, test } from "@playwright/test";
import { TEST_USERS } from "../constants/test-users";

test.describe("Harness operational UX", () => {
  test.use({ storageState: TEST_USERS.editor.authFile });

  test("manages remote connections with mocked APIs", async ({ page }) => {
    const now = new Date().toISOString();
    let agents: Array<Record<string, unknown>> = [];
    let createdBody: unknown;

    await page.route("**/api/remote-agents**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[2];

      if (request.method() === "GET") {
        return route.fulfill({ json: agents });
      }
      if (request.method() === "POST" && parts.at(-1) === "discover") {
        agents = agents.map((agent) =>
          agent.id === id
            ? {
                ...agent,
                agentCard: { name: agent.name, url: agent.endpointUrl },
              }
            : agent,
        );
        return route.fulfill({ json: agents.find((agent) => agent.id === id) });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        createdBody = body;
        const created = {
          id: "remote-1",
          ...body,
          credentialType: body.credential?.type ?? null,
          hasCredential: Boolean(body.credential),
          agentCard: null,
          discoveredAt: null,
          createdAt: now,
          updatedAt: now,
        };
        agents = [created];
        return route.fulfill({ status: 201, json: created });
      }
      if (request.method() === "PATCH") {
        const body = request.postDataJSON();
        agents = agents.map((agent) =>
          agent.id === id ? { ...agent, ...body, updatedAt: now } : agent,
        );
        return route.fulfill({ json: agents.find((agent) => agent.id === id) });
      }
      if (request.method() === "DELETE") {
        agents = agents.filter((agent) => agent.id !== id);
        return route.fulfill({ status: 204, body: "" });
      }
      return route.abort();
    });

    await page.goto("/remote-agents");
    await expect(
      page.getByRole("heading", { name: "Remote connections" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add connection" }).click();
    await page.getByLabel("Name").fill("Research partner");
    await page.getByLabel("Endpoint URL").fill("https://agent.example/a2a");
    await page.getByLabel("Credential type").click();
    await page.getByRole("option", { name: "API key" }).click();
    await page.getByLabel("Credential").fill("remote-secret");
    await page.getByLabel("Header name").fill("X-Partner-Key");
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(page.getByText("Research partner")).toBeVisible();
    await expect
      .poll(() => createdBody)
      .toEqual({
        name: "Research partner",
        endpointUrl: "https://agent.example/a2a",
        status: "active",
        credential: {
          type: "api_key",
          value: "remote-secret",
          headerName: "X-Partner-Key",
        },
      });

    await page.getByRole("button", { name: "Discover" }).click();
    await expect(page.getByText("Agent card ready")).toBeVisible();

    await page.getByRole("button", { name: "Connection actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Updated partner");
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(page.getByText("Updated partner")).toBeVisible();

    await page.getByRole("button", { name: "Connection actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("No remote connections")).toBeVisible();
  });

  test("resumes a waiting delegation from its timeline", async ({ page }) => {
    const run = {
      id: "run-1",
      parentRunId: null,
      status: "waiting_input",
      waitingReason: "Remote agent needs a project code",
      remoteMetadata: {
        waitingRequest: "Enter the requested project code",
        statusMessage: "Waiting for operator input",
      },
      depth: 0,
      tokenBudget: 50000,
      createdAt: new Date().toISOString(),
    };
    let resumedBody: unknown;

    await page.route("**/api/agent-runs", (route) =>
      route.fulfill({
        json: {
          roots: [run],
          runs: [run],
          delegations: [],
          summary: { active: 1, failed: 0, cancellable: 1 },
        },
      }),
    );
    await page.route("**/api/agent-runs/run-1/timeline", (route) =>
      route.fulfill({
        json: {
          run,
          delegations: [],
          events: [
            {
              id: "event-1",
              eventType: "agent.input_required",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      }),
    );
    await page.route("**/api/agent-runs/run-1/resume", async (route) => {
      resumedBody = route.request().postDataJSON();
      await route.fulfill({ json: { ...run, status: "queued" } });
    });

    await page.goto("/delegations");
    await page.getByRole("button", { name: "View timeline" }).click();
    await expect(
      page.getByText("agent.input_required", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Remote agent needs a project code"),
    ).toBeVisible();
    await expect(
      page.getByText("Enter the requested project code"),
    ).toBeVisible();
    await expect(page.getByText("Waiting for operator input")).toBeVisible();
    await page.getByLabel("Requested input").fill("IRIS-42");
    await page.getByRole("button", { name: "Resume run" }).click();

    await expect
      .poll(() => resumedBody)
      .toEqual({
        kind: "input",
        message: "IRIS-42",
      });
  });

  test("submits the requested API key credential for remote auth", async ({
    page,
  }) => {
    const run = {
      id: "run-auth",
      parentRunId: null,
      status: "waiting_approval",
      depth: 0,
      tokenBudget: 50000,
      remoteMetadata: {
        waitingRequest: "Authenticate with the partner API",
        statusMessage: { message: "API key required", secret: "[REDACTED]" },
      },
      createdAt: new Date().toISOString(),
    };
    let resumedBody: unknown;

    await page.route("**/api/agent-runs", (route) =>
      route.fulfill({
        json: {
          roots: [run],
          runs: [run],
          delegations: [],
          summary: { active: 1, failed: 0, cancellable: 1 },
        },
      }),
    );
    await page.route("**/api/agent-runs/run-auth/timeline", (route) =>
      route.fulfill({
        json: {
          run,
          delegations: [],
          events: [
            {
              id: "event-auth",
              eventType: "agent.auth_required",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      }),
    );
    await page.route("**/api/agent-runs/run-auth/resume", async (route) => {
      resumedBody = route.request().postDataJSON();
      await route.fulfill({ json: { ...run, status: "queued" } });
    });

    await page.goto("/delegations");
    await page.getByRole("button", { name: "View timeline" }).click();
    await expect(
      page.getByText("agent.auth_required", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Authenticate with the partner API"),
    ).toBeVisible();
    await expect(page.getByText("[REDACTED]", { exact: false })).toBeVisible();
    await page.getByLabel("Credential type").click();
    await page.getByRole("option", { name: "API key" }).click();
    await page.getByLabel("API key").fill("partner-secret");
    await page.getByLabel("Header name").fill("X-Partner-Key");
    await page.getByRole("button", { name: "Resume run" }).click();

    await expect
      .poll(() => resumedBody)
      .toEqual({
        kind: "credential",
        credential: {
          type: "api_key",
          value: "partner-secret",
          headerName: "X-Partner-Key",
        },
      });
  });
});
