"use client";

import { appStore } from "@/app/store";
import { useWorkspaces } from "@/hooks/queries/use-workspaces";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "ui/sidebar";
import { Check, ChevronDown, PanelsTopLeft, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";

function ScopeAperture({ scoped }: { scoped: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="relative flex size-5 shrink-0 items-center justify-center"
    >
      <span className="absolute size-4 rounded-[5px] border border-current opacity-40" />
      <span
        className={`size-2 rounded-[2px] ${
          scoped ? "bg-foreground" : "border border-current"
        }`}
      />
    </span>
  );
}

export function WorkspaceSwitcher() {
  const router = useRouter();
  const { data: workspaces = [] } = useWorkspaces();
  const activeWorkspaceId = appStore((state) => state.activeWorkspaceId);
  const activeWorkspace = workspaces.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );

  const selectWorkspace = (workspaceId?: string) => {
    appStore.setState({ activeWorkspaceId: workspaceId });
    router.push("/");
    router.refresh();
  };

  return (
    <SidebarMenu className="px-2 pb-2">
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              aria-label="Select workspace"
              className="h-11 border border-sidebar-border/70 bg-sidebar-accent/35 px-2.5"
            >
              <ScopeAperture scoped={Boolean(activeWorkspace)} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Work scope
                </span>
                <span className="block truncate text-sm font-medium">
                  {activeWorkspace?.name ?? "Global"}
                </span>
              </span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-64">
            <DropdownMenuLabel>Choose where Iris works</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => selectWorkspace()}>
              <PanelsTopLeft />
              <span className="flex-1">Global</span>
              {!activeWorkspaceId && <Check />}
            </DropdownMenuItem>
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onSelect={() => selectWorkspace(workspace.id)}
              >
                <ScopeAperture scoped />
                <span className="flex-1 truncate">{workspace.name}</span>
                {activeWorkspaceId === workspace.id && <Check />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push("/workspaces")}>
              <Settings2 />
              Manage workspaces
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
