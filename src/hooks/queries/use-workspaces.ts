"use client";

import type { Workspace, WorkspaceStatus } from "app-types/workspace";
import { fetcher } from "lib/utils";
import useSWR from "swr";

export function useWorkspaces(status: WorkspaceStatus = "active") {
  const query = new URLSearchParams({ status });
  return useSWR<Workspace[]>(`/api/workspaces?${query}`, fetcher, {
    fallbackData: [],
    revalidateOnFocus: false,
  });
}
