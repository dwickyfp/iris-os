import { describe, expect, it } from "vitest";
import {
  ModelCapabilitiesSchema,
  ProviderInputSchema,
} from "app-types/model-settings";

describe("runtime model setting validation", () => {
  it("defaults model capabilities to safe enabled values", () => {
    expect(ModelCapabilitiesSchema.parse({})).toEqual({
      toolCalls: true,
      vision: false,
      structuredOutput: true,
    });
  });

  it("accepts an OpenAI-compatible provider endpoint", () => {
    expect(
      ProviderInputSchema.parse({
        name: "Local API",
        type: "openai-compatible",
        baseUrl: "https://example.com/v1",
        apiKey: "secret",
      }).type,
    ).toBe("openai-compatible");
  });
});
