"use client";

import type { PublicRemoteAgent } from "app-types/remote-agent";
import { fetcher } from "lib/utils";
import useSWR from "swr";

export function useRemoteAgents() {
  return useSWR<PublicRemoteAgent[]>("/api/remote-agents", fetcher, {
    fallbackData: [],
    revalidateOnFocus: false,
  });
}
