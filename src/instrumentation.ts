import { IS_VERCEL_ENV } from "lib/const";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRuntimeSystemSettingsRefresh } = await import(
      "lib/system-settings/runtime"
    );
    await startRuntimeSystemSettingsRefresh();
    const { loadOperationsConfig } = await import("lib/operations/config");
    await loadOperationsConfig();

    // Optional OpenTelemetry trace export. Spans created by @ai-sdk/otel are
    // dropped unless a collector endpoint is configured.
    if (
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT &&
      process.env.OTEL_SDK_ENABLED !== "false"
    ) {
      try {
        const { NodeSDK } = await import("@opentelemetry/sdk-node");
        const { OTLPTraceExporter } = await import(
          "@opentelemetry/exporter-trace-otlp-http"
        );
        const sdk = new NodeSDK({
          traceExporter: new OTLPTraceExporter({
            url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`,
          }),
        });
        sdk.start();
        console.log(
          `[otel] Trace export enabled -> ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
        );
      } catch (error) {
        console.warn("[otel] Failed to start trace exporter", error);
      }
    }
  }

  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.AI_SDK_OTEL_ENABLED !== "false"
  ) {
    const [{ OpenTelemetry }, { registerTelemetry }] = await Promise.all([
      import("@ai-sdk/otel"),
      import("ai"),
    ]);
    registerTelemetry(
      new OpenTelemetry({
        enrichSpan: ({ spanType, operationId, callId }) => ({
          "iris-os.span_type": spanType,
          "iris-os.operation_id": operationId,
          "iris-os.call_id": callId,
        }),
      }),
    );
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Enable proxy support for undici (used by AI SDK) via HTTP_PROXY/HTTPS_PROXY env vars
    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy;
    if (proxyUrl) {
      const { ProxyAgent, setGlobalDispatcher } = await import("undici");
      console.log(`[proxy] Using proxy for fetch requests: ${proxyUrl}`);
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
    }
    if (!IS_VERCEL_ENV) {
      // Init MCP manager on all environments.
      // Cached servers are available instantly; new servers connect in background.
      const initMCPManager = await import("./lib/ai/mcp/mcp-manager").then(
        (m) => m.initMCPManager,
      );
      await initMCPManager();
    }
  }
}
