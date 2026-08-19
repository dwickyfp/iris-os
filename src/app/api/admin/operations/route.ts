import { getOperationsDiagnostics } from "lib/admin/operations";
import { requireAdminPermission } from "lib/auth/permissions";

export async function GET() {
  try {
    await requireAdminPermission("inspect operations diagnostics");
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    return Response.json(await getOperationsDiagnostics(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Operations diagnostics unavailable" },
      { status: 503 },
    );
  }
}
