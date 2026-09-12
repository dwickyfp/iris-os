/**
 * Renders the MCP OAuth callback result page. All interpolated values are
 * escaped: the callback URL is attacker-influenceable (query string), and the
 * page interpolates into both HTML text and an inline script.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON-encodes a value for safe interpolation inside a <script> block. */
export function escapeScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

type OAuthResponseOptions = {
  type: "success" | "error";
  title: string;
  heading: string;
  message: string;
  postMessageType: string;
  postMessageData: Record<string, unknown>;
  statusCode: number;
};

export function createOAuthResponsePage(
  options: OAuthResponseOptions,
): Response {
  const {
    type,
    title,
    heading,
    message,
    postMessageType,
    postMessageData,
    statusCode,
  } = options;
  const colorClass = type === "success" ? "success" : "error";
  const color = type === "success" ? "#22c55e" : "#ef4444";
  const postMessageEntries = Object.entries(postMessageData)
    .map(
      ([key, value]) => `${JSON.stringify(key)}: ${escapeScriptValue(value)}`,
    )
    .join(", ");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }
    .${colorClass} { color: ${color}; }
  </style>
</head>
<body>
  <script>
    try {
      window.opener?.postMessage({
        type: ${escapeScriptValue(postMessageType)},
        ${postMessageEntries}
      }, window.location.origin);
    } catch (e) {
      console.error('Failed to post message:', e);
    }
    setTimeout(() => window.close(), 1000);
  </script>
  <div class="${colorClass}">
    <h2>${escapeHtml(heading)}</h2>
    <p>${escapeHtml(message)}</p>
    <p>This window will close automatically.</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
