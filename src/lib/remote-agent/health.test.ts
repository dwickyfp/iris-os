import { describe, expect, it } from "vitest";
import { remoteAgentHealth } from "./health";

const now = new Date("2026-08-22T12:00:00.000Z");

describe("remoteAgentHealth", () => {
  it("reports auth required from cached Agent Card security state", () => {
    expect(
      remoteAgentHealth(
        {
          status: "active",
          agentCard: { name: "Secure", security: [{ bearer: [] }] },
          discoveredAt: now,
          credentialType: null,
          encryptedCredential: null,
        },
        { now },
      ),
    ).toMatchObject({
      status: "auth_required",
      reason: "credential_required",
    });
  });

  it("reports stale cached discovery as degraded", () => {
    expect(
      remoteAgentHealth(
        {
          status: "active",
          agentCard: { name: "Stale" },
          discoveredAt: new Date("2026-08-21T11:59:59.999Z"),
          credentialType: null,
          encryptedCredential: null,
        },
        { now },
      ),
    ).toMatchObject({ status: "degraded", reason: "agent_card_stale" });
  });
});
