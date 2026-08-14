import { AppHeader } from "@/components/layouts/app-header";
import { AppSidebar } from "@/components/layouts/app-sidebar";
import { cookies } from "next/headers";
import { SidebarProvider } from "ui/sidebar";

import { AppPopupProvider } from "@/components/layouts/app-popup-provider";
import { UserDetailContent } from "@/components/user/user-detail/user-detail-content";
import { UserDetailContentSkeleton } from "@/components/user/user-detail/user-detail-content-skeleton";
import { getSession } from "lib/auth/server";
import { COOKIE_KEY_SIDEBAR_STATE } from "lib/const";
import { SWRConfigProvider } from "./swr-config";
import { ChatSessionHost } from "@/components/chat-session-host";

import { redirect } from "next/navigation";
import { Suspense } from "react";
import { isV2FeatureEnabled } from "lib/feature-flags";
export default async function ChatLayout({
  children,
}: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }
  const isCollapsed =
    cookieStore.get(COOKIE_KEY_SIDEBAR_STATE)?.value !== "true";
  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <SWRConfigProvider user={session.user}>
        <AppPopupProvider
          userSettingsComponent={
            <Suspense fallback={<UserDetailContentSkeleton />}>
              <UserDetailContent view="user" />
            </Suspense>
          }
        />
        <AppSidebar
          user={session.user}
          workspacesEnabled={isV2FeatureEnabled("workspaces")}
        />
        <main className="relative flex h-svh min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <AppHeader />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ChatSessionHost />
            {children}
          </div>
        </main>
      </SWRConfigProvider>
    </SidebarProvider>
  );
}
