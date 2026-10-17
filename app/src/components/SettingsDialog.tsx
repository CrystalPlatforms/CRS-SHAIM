import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Loader2, Pencil, PlugZap, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";

import type { AppSettings, ModelInfo, Server, ServerKind, StoredSkill } from "@/types";
import { enabledTotalSize, formatBytes, isOverCap, SKILL_SIZE_CAP_BYTES } from "@/lib/skillsCap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Servers may have changed — DetailPane re-reads on next open. */
  onServersChanged: () => void;
}

type Tab = "servers" | "skills" | "system" | "defaults" | "about";

interface ServerStatus {
  state: "unknown" | "checking" | "online" | "offline";
  detail?: string;
}

export function SettingsDialog({ open, onClose, onServersChanged }: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>("servers");

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Model servers and app-wide defaults.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border">
          {(
            [
              ["servers", "Servers"],
              ["skills", "Skills"],
              ["system", "System prompt"],
              ["defaults", "Defaults"],
              ["about", "About"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "rounded-t-md px-3 py-1.5 text-sm transition-colors",
                tab === key
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "servers" ? (
          <ServersTab open={open} onServersChanged={onServersChanged} />
        ) : tab === "skills" ? (
          <SkillsTab open={open} />
        ) : tab === "system" ? (
          <SystemPromptTab open={open} />
        ) : tab === "defaults" ? (
          <DefaultsTab open={open} />
        ) : (
          <AboutTab />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Servers tab --------------------------------------------------------

function ServersTab({
  open,
  onServersChanged,
}: {
  open: boolean;
  onServersChanged: () => void;
}) {
  const [servers, setServers] = useState<Server[]>([]);
  const [statuses, setStatuses] = useState<Record<number, ServerStatus>>({});
  const [editing, setEditing] = useState<Server | "new" | null>(null);
  const [deleting, setDeleting] = useState<Server | null>(null);

  const loadServers = useCallback(async () => {
    try {
      setServers(await invoke<Server[]>("list_servers"));
    } catch (error) {
      console.error("Failed to load servers:", error);
    }
  }, []);

  useEffect(() => {
    if (open) void loadServers();
  }, [open, loadServers]);

  const checkServer = useCallback(async (server: Server) => {
    setStatuses((current) => ({ ...current, [server.id]: { state: "checking" } }));
    try {
      const models = await invoke<ModelInfo[]>("list_server_models", { id: server.id });
      setStatuses((current) => ({
        ...current,
        [server.id]: { state: "online", detail: `${models.length} models` },
      }));
    } catch (error) {
      setStatuses((current) => ({
        ...current,
        [server.id]: { state: "offline", detail: String(error) },
      }));
    }
  }, []);

  // Probe every server when the dialog opens.
  useEffect(() => {
    if (open) servers.forEach((server) => void checkServer(server));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, servers.length]);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await invoke("delete_server", { id: deleting.id });
      setDeleting(null);
      await loadServers();
      onServersChanged();
    } catch (error) {
      console.error("Failed to delete server:", error);
    }
  };

  return (
    <div className="space-y-3">
      {servers.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          <p>No servers yet. Add your Ollama box or any OpenAI-compatible endpoint.</p>
        </div>
      ) : (
        <ul className="max-h-64 space-y-2 overflow-y-auto">
          {servers.map((server) => {
            const status = statuses[server.id] ?? { state: "unknown" as const };
            return (
              <li
                key={server.id}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
              >
                <StatusDot state={status.state} />
                {/* `w-0` keeps the nowrap error text out of the row's
                    intrinsic width — without it the dialog grid column
                    grows past the card and the buttons overflow. */}
                <div className="w-0 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm">{server.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {server.kind === "ollama" ? "Ollama" : "OpenAI-compatible"}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{server.base_url}</div>
                  {status.detail && (
                    <div
                      className={cn(
                        "truncate text-[11px]",
                        status.state === "online" ? "text-primary" : "text-destructive"
                      )}
                      title={status.detail}
                    >
                      {status.detail}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    onClick={() => void checkServer(server)}
                    aria-label={`Test connection to ${server.name}`}
                    title="Test connection"
                  >
                    {status.state === "checking" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZap className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    onClick={() => setEditing(server)}
                    aria-label={`Edit ${server.name}`}
                    title="Edit"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleting(server)}
                    aria-label={`Delete ${server.name}`}
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus className="mr-1 h-4 w-4" />
          Add server
        </Button>
      </div>

      <ServerFormDialog
        server={editing === "new" ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await loadServers();
          onServersChanged();
        }}
      />

      <Dialog open={deleting !== null} onOpenChange={(next) => (!next ? setDeleting(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete server?</DialogTitle>
            <DialogDescription>
              “{deleting?.name}” will be removed. Past conversations that used it stay open —
              deleting a server never touches conversations.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusDot({ state }: { state: ServerStatus["state"] }) {
  return (
    <span
      aria-label={`Status: ${state}`}
      title={state}
      className={cn(
        "h-2.5 w-2.5 shrink-0 rounded-full",
        state === "online" && "bg-primary",
        state === "offline" && "bg-destructive",
        state === "checking" && "animate-pulse bg-muted-foreground/50",
        state === "unknown" && "bg-muted-foreground/30"
      )}
    />
  );
}

function ServerFormDialog({
  server,
  open,
  onClose,
  onSaved,
}: {
  server: Server | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ServerKind>("ollama");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setKind(server?.kind ?? "ollama");
    setBaseUrl(server?.base_url ?? "");
    setApiKey(server?.api_key ?? "");
    setValidationError(null);
  }, [open, server]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (!/^https?:\/\/.+/.test(trimmedUrl)) {
      setValidationError("Base URL must start with http:// or https://.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        kind,
        baseUrl: trimmedUrl,
        apiKey: apiKey.trim().length > 0 ? apiKey.trim() : null,
      };
      if (server) {
        await invoke("update_server", { id: server.id, ...payload });
      } else {
        await invoke("add_server", payload);
      }
      await onSaved();
    } catch (error) {
      setValidationError(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{server ? "Edit server" : "Add server"}</DialogTitle>
            <DialogDescription>
              Point Shaim at an Ollama instance or any OpenAI-compatible endpoint.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-3 space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Linux box"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Kind</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ServerKind)}
                className="w-full appearance-none rounded-md border border-input bg-input px-2 py-2 text-sm outline-none"
              >
                <option value="ollama">Ollama</option>
                <option value="openai_compatible">OpenAI-compatible</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Base URL</span>
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://192.168.1.10:11434"
              />
              <span className="block text-[11px] text-muted-foreground">
                Ollama: http://host:11434 · Open WebUI: http://host:8080/api
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                API key {kind === "openai_compatible" ? "(sent as Bearer header)" : "(optional)"}
              </span>
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Leave empty if not needed"
              />
            </label>

            {validationError && (
              <p className="text-xs text-destructive">{validationError}</p>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {server ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Skills tab ------------------------------------------------------------

function SkillsTab({ open }: { open: boolean }) {
  const [skills, setSkills] = useState<StoredSkill[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StoredSkill | null>(null);
  const [deleting, setDeleting] = useState<StoredSkill | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      setSkills(await invoke<StoredSkill[]>("list_skills"));
    } catch (error) {
      console.error("Failed to load skills:", error);
    }
  }, []);

  useEffect(() => {
    if (open) void loadSkills();
  }, [open, loadSkills]);

  // "Add skill" opens a file picker (.skill package or .md file) and hands
  // the chosen path to the SkillStore.
  const importSkill = async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Skill (.skill, .md)", extensions: ["skill", "md"] }],
    });
    if (typeof picked !== "string") return;
    setImporting(true);
    setImportError(null);
    try {
      await invoke<StoredSkill>("import_skill", { path: picked });
      await loadSkills();
    } catch (error) {
      setImportError(String(error));
    } finally {
      setImporting(false);
    }
  };

  const toggle = async (skill: StoredSkill, enabled: boolean) => {
    try {
      await invoke("set_skill_enabled", { id: skill.id, enabled });
      setSkills((current) =>
        current.map((item) => (item.id === skill.id ? { ...item, enabled } : item))
      );
    } catch (error) {
      console.error("Failed to toggle skill:", error);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await invoke("delete_skill", { id: deleting.id });
      setDeleting(null);
      await loadSkills();
    } catch (error) {
      console.error("Failed to delete skill:", error);
    }
  };

  const totalBytes = enabledTotalSize(skills);
  const overCap = isOverCap(totalBytes);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Enabled skills join system prompts in server-model conversations only — they are
        never sent to Claude Code or Codex.
      </p>

      {overCap && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Enabled skills use {formatBytes(totalBytes)} — past the{" "}
            {formatBytes(SKILL_SIZE_CAP_BYTES)} prompt budget. Disable or trim some to
            keep requests lean.
          </span>
        </div>
      )}

      {skills.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          <p>No skills yet. Import a .skill package or a markdown instruction file.</p>
        </div>
      ) : (
        <ul className="max-h-64 space-y-2 overflow-y-auto">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
            >
              <SkillToggle skill={skill} onToggle={(enabled) => void toggle(skill, enabled)} />
              <div className="w-0 min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm">{skill.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {skill.kind === "package" ? "Package" : "Markdown"}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {formatBytes(skill.size_bytes)}
                  </span>
                </div>
                {skill.description && (
                  <div className="truncate text-xs text-muted-foreground">
                    {skill.description}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={() => setEditing(skill)}
                  aria-label={`Edit ${skill.name}`}
                  title="Edit content"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleting(skill)}
                  aria-label={`Delete ${skill.name}`}
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void importSkill()} disabled={importing}>
          {importing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
          Add skill
        </Button>
      </div>

      {importError && <p className="text-xs text-destructive">{importError}</p>}

      <EditSkillDialog
        skill={editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await loadSkills();
        }}
      />

      <Dialog open={deleting !== null} onOpenChange={(next) => (!next ? setDeleting(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete skill?</DialogTitle>
            <DialogDescription>
              “{deleting?.name}” and its files will be removed from the library. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillToggle({
  skill,
  onToggle,
}: {
  skill: StoredSkill;
  onToggle: (enabled: boolean) => void;
}) {
  // Explicit pixel sizing + style-driven knob travel: the project's
  // `--spacing` scale shifts Tailwind size utilities, which used to stretch
  // the track and push the knob off it.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={skill.enabled}
      aria-label={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
      onClick={() => onToggle(!skill.enabled)}
      style={{ width: 34, height: 20, padding: 2 }}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-colors",
        skill.enabled ? "bg-primary" : "bg-muted-foreground/30"
      )}
    >
      <span
        style={{
          width: 14,
          height: 14,
          transform: skill.enabled ? "translateX(14px)" : "translateX(0px)",
        }}
        className="rounded-full bg-background shadow-sm transition-transform"
      />
    </button>
  );
}

function EditSkillDialog({
  skill,
  open,
  onClose,
  onSaved,
}: {
  skill: StoredSkill | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !skill) return;
    setName(skill.name);
    setLoading(true);
    setError(null);
    invoke<string>("get_skill_content", { id: skill.id })
      .then(setBody)
      .catch((loadError) => setError(String(loadError)))
      .finally(() => setLoading(false));
  }, [open, skill]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!skill) return;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Name cannot be empty.");
      return;
    }
    setSaving(true);
    try {
      if (trimmedName !== skill.name) {
        await invoke("rename_skill", { id: skill.id, name: trimmedName });
      }
      await invoke("save_skill_content", { id: skill.id, body });
      await onSaved();
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit skill — {skill?.name}</DialogTitle>
          </DialogHeader>
          <div className="mt-3 space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Skill name"
              />
            </label>
            <textarea
              rows={10}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={loading}
              placeholder={loading ? "Loading…" : "Skill instructions…"}
              className="w-full resize-y rounded-md border border-input bg-input px-2 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- System prompt tab ----------------------------------------------------

function SystemPromptTab({ open }: { open: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const current = await invoke<AppSettings>("get_settings");
        setPrompt(current.default_system_prompt ?? "");
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    })();
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await invoke("set_default_system_prompt", {
        prompt: prompt.trim().length > 0 ? prompt : null,
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      console.error("Failed to save default system prompt:", error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Default system prompt</span>
        <textarea
          rows={6}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Instructions sent with every conversation whose system prompt is left on “Use default”…"
          className="w-full resize-y rounded-md border border-input bg-input px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-xs text-primary">Saved.</span>}
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}

// ---- Defaults tab -------------------------------------------------------

function DefaultsTab({ open }: { open: boolean }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [serverList, currentSettings] = await Promise.all([
          invoke<Server[]>("list_servers"),
          invoke<AppSettings>("get_settings"),
        ]);
        setServers(serverList);
        setSettings(currentSettings);
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    })();
  }, [open]);

  // Load models whenever the picked default server changes.
  useEffect(() => {
    const serverId = settings?.default_server_id ?? null;
    if (!open || serverId === null) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    invoke<ModelInfo[]>("list_server_models", { id: serverId })
      .then((loaded) => {
        if (!cancelled) setModels(loaded);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, settings?.default_server_id]);

  const save = async (serverId: number | null, modelId: string | null) => {
    try {
      await invoke("set_default_model", { serverId, modelId });
      setSettings((current) => ({
        default_server_id: serverId,
        default_model_id: modelId,
        default_system_prompt: current?.default_system_prompt ?? null,
      }));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (error) {
      console.error("Failed to save defaults:", error);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Default server</span>
        <select
          aria-label="Default server"
          value={settings?.default_server_id ?? ""}
          onChange={(event) =>
            void save(event.target.value ? Number(event.target.value) : null, null)
          }
          className="w-full appearance-none rounded-md border border-input bg-input px-2 py-2 text-sm outline-none"
        >
          <option value="">— none —</option>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Default model</span>
        <div className="relative">
          <select
            aria-label="Default model"
            value={settings?.default_model_id ?? ""}
            disabled={loadingModels || models.length === 0}
            onChange={(event) =>
              void save(settings?.default_server_id ?? null, event.target.value || null)
            }
            className="w-full appearance-none rounded-md border border-input bg-input px-2 py-2 text-sm outline-none disabled:opacity-50"
          >
            <option value="">
              {loadingModels ? "Loading models…" : models.length === 0 ? "No models" : "— none —"}
            </option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
          {loadingModels && (
            <RefreshCw className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      </label>

      {saved && <p className="text-xs text-primary">Saved.</p>}
      <p className="text-xs text-muted-foreground">
        Conversations fall back to these defaults when they have no model of their own.
      </p>
    </div>
  );
}

// ---- About tab -------------------------------------------------------------

function AboutTab() {
  return (
    <div className="flex flex-col items-center gap-1 py-6 text-center">
      <h3 className="font-display text-4xl">Shaim</h3>
      <p className="text-sm text-foreground">Shaim Alpha v.0.0.1</p>
      <p className="text-xs text-muted-foreground">CrystalPlatforms</p>
    </div>
  );
}
