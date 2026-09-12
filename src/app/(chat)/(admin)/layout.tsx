import { requireAdminPermission } from "auth/permissions";
import { unauthorized } from "next/navigation";
import type { ReactNode } from "react";

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
