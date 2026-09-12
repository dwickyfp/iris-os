import { describe, expect, test } from "vitest";
import {
  createOAuthResponsePage,
  escapeHtml,
  escapeScriptValue,
} from "./oauth-response-page";

describe("escapeHtml", () => {
  test("escapes HTML metacharacters", () => {
    expect(escapeHtml(`<img src=x onerror="alert('pwn')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;pwn&#39;)&quot;&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});

describe("escapeScriptValue", () => {
  test("neutralizes script-breakout and HTML injection via JSON encoding", () => {
    const attack = `'}); alert(document.cookie); ({x:'`;
    const encoded = escapeScriptValue(attack);
    // The payload is kept inside a double-quoted JSON string literal, so it
    // cannot break out of the enclosing script context.
    expect(encoded.startsWith('"')).toBe(true);
    expect(encoded.endsWith('"')).toBe(true);
    expect(encoded).not.toMatch(/<\/script>/i);
  });

  test("escapes angle brackets and line separators", () => {
    expect(escapeScriptValue("</script><script>alert(1)</script>")).toBe(
      '"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"',
    );
    expect(escapeScriptValue("ab")).toBe('"ab"');
  });
});

describe("createOAuthResponsePage", () => {
  test("error page escapes attacker-controlled query parameters", async () => {
    const response = createOAuthResponsePage({
      type: "error",
      title: "OAuth Error",
      heading: "Authentication Failed",
      message: "Error: bad — '});alert(document.domain);//",
      postMessageType: "MCP_OAUTH_ERROR",
      postMessageData: {
        error: "bad",
        error_description: `'});alert(document.domain);//`,
      },
      statusCode: 400,
    });
    const html = await response.text();

    // The attacker-controlled description is embedded as a JSON string
    // literal, so the quote-breakout attempt stays inside the string.
    expect(html).toContain(`"'});alert(document.domain);//"`);
    expect(html).toContain('"bad"');
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("success page embeds the postMessage payload as JSON", async () => {
    const response = createOAuthResponsePage({
      type: "success",
      title: "OAuth Success",
      heading: "Authentication Successful!",
      message: "You can now close this window.",
      postMessageType: "MCP_OAUTH_SUCCESS",
      postMessageData: { success: true },
      statusCode: 200,
    });
    const html = await response.text();

    expect(html).toContain('type: "MCP_OAUTH_SUCCESS"');
    expect(html).toContain('"success": true');
  });
});
