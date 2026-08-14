import { WorkspaceListPage } from "@/components/workspace/workspace-list-page";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function WorkspacesPage() {
  if (!isV2FeatureEnabled("workspaces")) notFound();
  return <WorkspaceListPage />;
}
