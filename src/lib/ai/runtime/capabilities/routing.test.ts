import { describe, expect, it } from "vitest";
import { mergePreferredCapabilities } from "./routing";

describe("mergePreferredCapabilities", () => {
  it("retains other eligible capabilities for an ordinary mention", () => {
    expect(
      mergePreferredCapabilities(
        { eligible: 1, requested: 2 },
        { requested: 9 },
        [
          {
            type: "defaultTool",
            name: "requested",
            label: "Requested",
            routingMode: "prefer",
          },
        ],
      ),
    ).toEqual({ requested: 2, eligible: 1 });
  });

  it("filters to requested capabilities in only mode", () => {
    expect(
      mergePreferredCapabilities(
        { eligible: 1, requested: 2 },
        { requested: 9 },
        [
          {
            type: "defaultTool",
            name: "requested",
            label: "Requested",
            routingMode: "only",
          },
        ],
      ),
    ).toEqual({ requested: 2 });
  });

  it("never adds a requested capability that is not eligible", () => {
    expect(
      mergePreferredCapabilities({ eligible: 1 }, { unauthorized: 2 }, [
        {
          type: "defaultTool",
          name: "unauthorized",
          label: "Unauthorized",
          routingMode: "prefer",
        },
      ]),
    ).toEqual({ eligible: 1 });

    expect(
      mergePreferredCapabilities({ eligible: 1 }, { unauthorized: 2 }, [
        {
          type: "defaultTool",
          name: "unauthorized",
          label: "Unauthorized",
          routingMode: "only",
        },
      ]),
    ).toEqual({});
  });
});
