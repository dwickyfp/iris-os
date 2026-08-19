import { hasValidMetricsBearer } from "lib/operations/auth";
import { parseOperationsConfig } from "lib/operations/config";
import { renderPrometheus } from "lib/operations/prometheus";
import { getOperationsSnapshot } from "lib/operations/snapshot";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let config;
  try {
    config = parseOperationsConfig(process.env);
  } catch {
    return new Response("Service unavailable\n", { status: 503 });
  }
  if (
    !config.OPERATIONS_METRICS_TOKEN ||
    !hasValidMetricsBearer(
      request.headers.get("authorization"),
      config.OPERATIONS_METRICS_TOKEN,
    )
  ) {
    return new Response("Unauthorized\n", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  try {
    return new Response(renderPrometheus(await getOperationsSnapshot(config)), {
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Service unavailable\n", { status: 503 });
  }
}
