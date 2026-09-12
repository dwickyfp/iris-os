import { tool as createTool } from "ai";
import { JSONSchema7 } from "json-schema";
import { jsonSchemaToZod } from "lib/json-schema-to-zod";
import { secureFetchResponse } from "lib/security/outbound-http";
import { safe } from "ts-safe";

export const httpFetchSchema: JSONSchema7 = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "The URL to make the HTTP request to",
    },
    method: {
      type: "string",
      enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      description: "The HTTP method to use",
      default: "GET",
    },
    headers: {
      type: "object",
      description: "Headers to include in the request",
      properties: {},
      additionalProperties: true,
    },
    body: {
      type: "string",
      description:
        "The request body (for POST, PUT, PATCH requests). Should be a JSON string if sending JSON data.",
    },
    timeout: {
      type: "number",
      description: "Request timeout in milliseconds",
      default: 10000,
    },
  },
  required: ["url"],
};

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export const httpFetchTool = createTool({
  description:
    "Make HTTP requests to public internet URLs. Can be used to fetch data from APIs, send data to servers, or interact with web services. Requests to private, loopback, or link-local addresses are blocked.",
  inputSchema: jsonSchemaToZod(httpFetchSchema),
  execute: async ({ url, method = "GET", headers, body, timeout = 10000 }) => {
    return safe(async () => {
      const response = await secureFetchResponse(
        url,
        {
          method,
          headers: headers ? { ...headers } : undefined,
          body:
            body && method !== "GET" && method !== "HEAD" ? body : undefined,
        },
        {
          timeoutMs: Math.min(
            Math.max(timeout, MIN_TIMEOUT_MS),
            MAX_TIMEOUT_MS,
          ),
          // The tool is a general-purpose HTTP client, but every request is
          // still validated against public DNS-resolved addresses only.
          allowHttp: true,
          maxBodyBytes: MAX_RESPONSE_BYTES,
        },
      );

      const contentType = response.headers["content-type"];
      let responseBody: any;
      if (contentType?.includes("application/json")) {
        try {
          responseBody = JSON.parse(response.body);
        } catch {
          responseBody = response.body;
        }
      } else {
        responseBody = response.body;
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: responseBody,
        ok: response.ok,
        url: response.url,
      };
    })
      .ifFail((err) => {
        return {
          isError: true,
          error: err.message,
          solution:
            "An HTTP request error occurred. This could be due to network issues, an invalid URL, a blocked private address, timeout, or server errors. Check the URL and try again.",
        };
      })
      .unwrap();
  },
});
