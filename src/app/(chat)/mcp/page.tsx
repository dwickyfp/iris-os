import MCPDashboard from "@/components/mcp-dashboard";
import { getSession } from "auth/server";
import { IS_VERCEL_ENV } from "lib/const";
import { runtimeSystemSetting } from "lib/system-settings/runtime";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

// Force dynamic rendering to avoid static generation issues with session
export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await getSession();
  if (!session?.user) {
    return redirect("/login");
  }

  const isAddingDisabled = !runtimeSystemSetting("mcp.allowUserServers");

  const t = await getTranslations("Info");
  let message: string | undefined;

  if (isAddingDisabled) {
    message = t("mcpAddingDisabled");
  } else if (IS_VERCEL_ENV) {
    message = t("vercelSyncDelay");
  }

  return <MCPDashboard message={message} user={session?.user} />;
}
