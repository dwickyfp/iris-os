"use client";

import { appStore } from "@/app/store";
import { useRouter } from "next/navigation";
import { Button } from "ui/button";

export function ContinueWorkButton({
  taskId,
  workspaceId,
}: {
  taskId: string;
  workspaceId?: string | null;
}) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      onClick={() => {
        appStore.setState({
          activeTaskId: taskId,
          activeWorkspaceId: workspaceId ?? undefined,
        });
        router.push("/");
      }}
    >
      Continue work
    </Button>
  );
}
