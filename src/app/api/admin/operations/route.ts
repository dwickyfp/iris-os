import { getOperationsDiagnostics } from "lib/admin/operations";
import { requireAdminPermission } from "lib/auth/permissions";

export async function GET() {
  try {
    await requireAdminPermission("inspect operations diagnostics");
    return Response.json(await getOperationsDiagnostics());
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
}
