"use client";

import { fetcher } from "lib/utils";
import useSWR from "swr";

export type RunInboxItem = {
  id: string;
  rootRunId: string | null;
  targetRunId: string | null;
  mode: "followup" | "steer" | "inject";
  source: "user" | "system" | "a2a" | "workflow" | "job" | "automation";
  status: "open";
  content: Record<string, unknown>;
  goalRevision: number | null;
  createdAt: string;
};

export function useRunInbox() {
  return useSWR<RunInboxItem[]>("/api/run-inbox", fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: 0,
    fallbackData: [],
  });
}

export function useRunInboxCount() {
  return useSWR<{ open: number }>("/api/run-inbox?summary=1", fetcher, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    refreshInterval: 0,
    fallbackData: { open: 0 },
  });
}
