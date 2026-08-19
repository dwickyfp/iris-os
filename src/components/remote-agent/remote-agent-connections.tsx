"use client";

import type {
  PublicRemoteAgent,
  RemoteAgentCredential,
} from "app-types/remote-agent";
import {
  Cable,
  CheckCircle2,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { useRemoteAgents } from "@/hooks/queries/use-remote-agents";

type FormState = {
  name: string;
  endpointUrl: string;
  status: "active" | "disabled";
  credentialType: "none" | RemoteAgentCredential["type"];
  credential: string;
  headerName: string;
};

const emptyForm: FormState = {
  name: "",
  endpointUrl: "",
  status: "active",
  credentialType: "none",
  credential: "",
  headerName: "X-API-Key",
};

export function RemoteAgentConnections() {
  const t = useTranslations("RemoteAgents");
  const { data = [], error, isLoading, mutate } = useRemoteAgents();
  const [editing, setEditing] = useState<PublicRemoteAgent | null>();
  const [deleting, setDeleting] = useState<PublicRemoteAgent | null>();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState<string>();

  function openForm(agent?: PublicRemoteAgent) {
    setEditing(agent ?? null);
    setForm(
      agent
        ? {
            name: agent.name,
            endpointUrl: agent.endpointUrl,
            status: agent.status,
            credentialType: agent.credentialType ?? "none",
            credential: "",
            headerName: "X-API-Key",
          }
        : emptyForm,
    );
  }

  async function save() {
    setBusy("save");
    const credential = form.credential
      ? form.credentialType === "api_key"
        ? {
            type: "api_key" as const,
            value: form.credential,
            headerName: form.headerName,
          }
        : form.credentialType === "bearer"
          ? { type: "bearer" as const, value: form.credential }
          : undefined
      : undefined;
    try {
      const response = await fetch(
        editing ? `/api/remote-agents/${editing.id}` : "/api/remote-agents",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name,
            endpointUrl: form.endpointUrl,
            status: form.status,
            ...(credential
              ? { credential }
              : editing && form.credentialType === "none"
                ? { credential: null }
                : {}),
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        toast.error(body?.error ?? t("saveFailed"));
        return;
      }
      const wasEditing = Boolean(editing);
      setEditing(undefined);
      await mutate();
      toast.success(t(wasEditing ? "updated" : "created"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setBusy(undefined);
    }
  }

  async function discover(agent: PublicRemoteAgent) {
    setBusy(agent.id);
    const response = await fetch(`/api/remote-agents/${agent.id}/discover`, {
      method: "POST",
    });
    setBusy(undefined);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      toast.error(body?.error ?? t("discoveryFailed"));
      return;
    }
    await mutate();
    toast.success(t("discovered"));
  }

  async function remove() {
    if (!deleting) return;
    setBusy("delete");
    const response = await fetch(`/api/remote-agents/${deleting.id}`, {
      method: "DELETE",
    });
    setBusy(undefined);
    if (!response.ok) return toast.error(t("deleteFailed"));
    setDeleting(null);
    await mutate();
    toast.success(t("deleted"));
  }

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-6 md:p-10">
      <header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {t("eyebrow")}
          </p>
          <h1 className="mt-2 text-3xl font-semibold">{t("title")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button onClick={() => openForm()}>
          <Plus /> {t("add")}
        </Button>
      </header>

      {error && <p className="text-sm text-destructive">{t("loadFailed")}</p>}
      <section aria-busy={isLoading} className="grid gap-4 md:grid-cols-2">
        {isLoading && (
          <div className="col-span-full flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t("loading")}
          </div>
        )}
        {!isLoading && data.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed p-10 text-center">
            <Cable className="mx-auto size-7 text-muted-foreground" />
            <p className="mt-3 font-medium">{t("emptyTitle")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("emptyDescription")}
            </p>
          </div>
        )}
        {data.map((agent) => (
          <article key={agent.id} className="rounded-xl border p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <Cable className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-semibold">{agent.name}</h2>
                  <Badge
                    variant={
                      agent.status === "active" ? "secondary" : "outline"
                    }
                  >
                    {t(agent.status)}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {agent.endpointUrl}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t("actions")}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => openForm(agent)}>
                    {t("edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setDeleting(agent)}
                  >
                    <Trash2 /> {t("delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="mt-5 flex items-center justify-between border-t pt-4">
              <div className="text-xs text-muted-foreground">
                {agent.agentCard ? (
                  <span className="flex items-center gap-1.5 text-foreground">
                    <CheckCircle2 className="size-3.5 text-emerald-500" />
                    {t("cardReady")}
                  </span>
                ) : (
                  t("notDiscovered")
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === agent.id}
                onClick={() => void discover(agent)}
              >
                <RefreshCw
                  className={busy === agent.id ? "animate-spin" : ""}
                />
                {t(agent.agentCard ? "rediscover" : "discover")}
              </Button>
            </div>
          </article>
        ))}
      </section>

      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(editing ? "editTitle" : "addTitle")}</DialogTitle>
            <DialogDescription>{t("formDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field id="remote-agent-name" label={t("name")}>
              <Input
                id="remote-agent-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field id="remote-agent-endpoint" label={t("endpoint")}>
              <Input
                id="remote-agent-endpoint"
                type="url"
                value={form.endpointUrl}
                onChange={(e) =>
                  setForm({ ...form, endpointUrl: e.target.value })
                }
              />
            </Field>
            <Field id="remote-agent-status" label={t("status")}>
              <Select
                value={form.status}
                onValueChange={(status: FormState["status"]) =>
                  setForm({ ...form, status })
                }
              >
                <SelectTrigger id="remote-agent-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t("active")}</SelectItem>
                  <SelectItem value="disabled">{t("disabled")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="remote-agent-credential-type"
              label={t("credentialType")}
            >
              <Select
                value={form.credentialType}
                onValueChange={(credentialType: FormState["credentialType"]) =>
                  setForm({ ...form, credentialType })
                }
              >
                <SelectTrigger
                  id="remote-agent-credential-type"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("none")}</SelectItem>
                  <SelectItem value="bearer">{t("bearer")}</SelectItem>
                  <SelectItem value="api_key">{t("apiKey")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {form.credentialType !== "none" && (
              <Field id="remote-agent-credential" label={t("credential")}>
                <Input
                  id="remote-agent-credential"
                  type="password"
                  value={form.credential}
                  placeholder={
                    editing?.hasCredential
                      ? t("credentialUnchanged")
                      : undefined
                  }
                  onChange={(e) =>
                    setForm({ ...form, credential: e.target.value })
                  }
                />
              </Field>
            )}
            {form.credentialType === "api_key" && (
              <Field id="remote-agent-header" label={t("headerName")}>
                <Input
                  id="remote-agent-header"
                  value={form.headerName}
                  onChange={(e) =>
                    setForm({ ...form, headerName: e.target.value })
                  }
                />
              </Field>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(undefined)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={!form.name || !form.endpointUrl || busy === "save"}
              onClick={() => void save()}
            >
              {busy === "save" && <Loader2 className="animate-spin" />}{" "}
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteDescription", { name: deleting?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy === "delete"}
              onClick={() => void remove()}
            >
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
