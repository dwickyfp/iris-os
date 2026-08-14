"use client";

import { appStore } from "@/app/store";
import { useWorkspaces } from "@/hooks/queries/use-workspaces";
import type { Workspace } from "app-types/workspace";
import { Archive, ArrowUpRight, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "ui/button";
import { Card, CardContent, CardHeader } from "ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";
import { workspaceSlugFromName } from "lib/workspace/slug";

function WorkspaceEditor({
  workspace,
  open,
  onOpenChange,
  onSaved,
}: {
  workspace?: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(workspace?.name ?? "");
    setDescription(workspace?.description ?? "");
    setInstructions(workspace?.instructions ?? "");
  }, [open, workspace]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch(
        workspace ? `/api/workspaces/${workspace.id}` : "/api/workspaces",
        {
          method: workspace ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            ...(!workspace ? { slug: workspaceSlugFromName(name) } : {}),
            description: description || undefined,
            instructions: instructions || undefined,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "Workspace could not be saved",
        );
      toast.success(workspace ? "Workspace updated" : "Workspace created");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Workspace could not be saved",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={save}>
          <DialogHeader>
            <DialogTitle>
              {workspace ? "Edit workspace" : "Create workspace"}
            </DialogTitle>
            <DialogDescription>
              Keep project context and instructions available across chats.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-6">
            <div className="grid gap-2">
              <Label htmlFor="workspace-name">Name</Label>
              <Input
                id="workspace-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="IRIS-OS"
                maxLength={120}
                required
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="workspace-description">Description</Label>
              <Input
                id="workspace-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What belongs in this workspace?"
                maxLength={2_000}
              />
            </div>
            <div className="grid gap-2">
              <div className="flex items-baseline justify-between gap-4">
                <Label htmlFor="workspace-instructions">Instructions</Label>
                <span className="font-mono text-[10px] text-muted-foreground">
                  Trusted configuration
                </span>
              </div>
              <Textarea
                id="workspace-instructions"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Use pnpm. Preserve existing architecture. Run tests before completion."
                maxLength={20_000}
                className="min-h-40 resize-y font-mono text-xs leading-5"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceListPage() {
  const router = useRouter();
  const { data: workspaces = [], isLoading, mutate } = useWorkspaces();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Workspace>();

  const openEditor = (workspace?: Workspace) => {
    setEditing(workspace);
    setEditorOpen(true);
  };

  const startChat = (workspaceId: string) => {
    appStore.setState({ activeWorkspaceId: workspaceId });
    router.push("/");
    router.refresh();
  };

  const archiveWorkspace = async (workspace: Workspace) => {
    const response = await fetch(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    if (!response.ok) {
      toast.error("Workspace could not be archived");
      return;
    }
    if (appStore.getState().activeWorkspaceId === workspace.id)
      appStore.setState({ activeWorkspaceId: undefined });
    toast.success("Workspace archived");
    await mutate();
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10 md:px-8 md:py-14">
      <div className="mb-10 flex flex-col gap-6 border-b pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Durable work context
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Give each project its own instructions and conversation scope.
            Global chat remains available for work that does not belong to a
            project.
          </p>
        </div>
        <Button onClick={() => openEditor()}>
          <Plus />
          Create workspace
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading workspaces…</p>
      ) : workspaces.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-16 text-center">
          <p className="font-medium">No project context yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Create a workspace for a project whose instructions and memory
            should stay separate from everything else.
          </p>
          <Button
            className="mt-6"
            variant="secondary"
            onClick={() => openEditor()}
          >
            Create your first workspace
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {workspaces.map((workspace) => (
            <Card key={workspace.id} className="group shadow-none">
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    /{workspace.slug}
                  </p>
                  <h2 className="mt-1 truncate text-lg font-semibold">
                    {workspace.name}
                  </h2>
                </div>
                <div className="relative mt-1 flex size-7 items-center justify-center">
                  <span className="absolute size-6 rounded-md border opacity-40" />
                  <span className="size-2.5 rounded-[3px] bg-foreground" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="min-h-10 text-sm leading-5 text-muted-foreground">
                  {workspace.description || "No description yet."}
                </p>
                <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
                  <Button size="sm" onClick={() => startChat(workspace.id)}>
                    Start chat
                    <ArrowUpRight />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEditor(workspace)}
                  >
                    <Pencil />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-muted-foreground"
                    onClick={() => archiveWorkspace(workspace)}
                  >
                    <Archive />
                    Archive
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <WorkspaceEditor
        workspace={editing}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSaved={() => mutate()}
      />
    </div>
  );
}
