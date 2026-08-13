"use client";

import { BasicUser } from "app-types/user";
import { useEffect, useMemo } from "react";
import { SWRConfig, SWRConfiguration } from "swr";

export function SWRConfigProvider({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: BasicUser;
}) {
  const config = useMemo<SWRConfiguration>(() => {
    return {
      focusThrottleInterval: 30000,
      dedupingInterval: 2000,
      errorRetryCount: 1,
      fallback: {
        "/api/user/details": user,
      },
    };
  }, [user]);

  useEffect(() => {
    console.log(
      "%cIRIS OS\n\n%cThe open operating system for AI agents, tools, and workflows.\nhttps://github.com/dwickyfp/iris-os",
      "color: #00d4ff; font-weight: bold; font-family: monospace; font-size: 16px; text-shadow: 0 0 10px #00d4ff;",
      "color: #888; font-size: 12px;",
    );
  }, []);
  return <SWRConfig value={config}>{children}</SWRConfig>;
}
