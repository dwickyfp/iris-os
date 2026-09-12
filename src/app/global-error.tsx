"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "60vh",
          gap: "1rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Application error</h2>
        <p style={{ color: "#666", margin: 0 }}>
          The application failed to start rendering this page.
        </p>
        {error.digest && (
          <code style={{ fontSize: "0.75rem", color: "#999" }}>
            digest: {error.digest}
          </code>
        )}
        <button
          onClick={reset}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "0.5rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
