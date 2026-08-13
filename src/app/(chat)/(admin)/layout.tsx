import type { ReactNode } from "react";
import { requireAdminPermission } from "auth/permissions";
import { unauthorized } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  try {
    await requireAdminPermission();
  } catch (_error) {
    unauthorized();
  }
  return <>{children}</>;
}
