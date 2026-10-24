import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, Info, Loader2, Pencil, PlugZap, Plus, RefreshCw, Terminal, Trash2, TriangleAlert, Wrench, X } from "lucide-react";
import { ModePill } from "@/components/ChatPane";

import type { AllowedRule, AppSettings, ModelInfo, Server, ServerKind, StoredSkill } from "@/types";
import { enabledTotalSize, formatBytes, isOverCap, SKILL_SIZE_CAP_BYTES } from "@/lib/skillsCap";
import {
  defaultUpdaterApi,
  downloadProgressText,
  runCheck,
  runInstall,
  UpdateFlowError,
  type UpdateResource,
  type UpdateState,
} from "@/lib/updater";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
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

type Tab = "servers" | "skills" | "allowed" | "system" | "defaults" | "about";

interface ServerStatus {
  state: "unknown" | "checking" | "online" | "offline";
  detail?: string;
}

export function SettingsDialog({ open, onClose, onServersChanged }: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>("servers");
  const hint = TAB_HINTS[tab];

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      {/* `fixed` in ui/dialog centers the card — adding `relative` here
          would clobber it (twMerge keeps the later position class). The
          corner controls anchor to the fixed box directly. */}
      <DialogContent className="max-w-xl">
        <div className="absolute right-3 top-3 flex items-center gap-1">
          {hint && <TabInfoHint label={hint.label} text={hint.text} />}
          <DialogClose
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close settings"
            title="Close"
          >
            <X className="h-4 w-4" />
          </DialogClose>
        </div>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border">
          {(
            [
              ["servers", "Servers"],
              ["skills", "Skills"],
              ["allowed", "Allowed"],
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
        ) : tab === "allowed" ? (
          <AllowedTab open={open} />
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

  // App.refresh() only reloads conversations — open panes that keep their
  // own server list (DetailPane) learn about changes through this event.
  const notifyServersChanged = useCallback(() => {
    onServersChanged();
    window.dispatchEvent(new Event("klepai:servers-changed"));
  }, [onServersChanged]);

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
      notifyServersChanged();
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
          notifyServersChanged();
        }}
      />

      <Dialog open={deleting !== null} onOpenChange={(next) => (!next ? setDeleting(null) : undefined)}>
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Delete server?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" autoFocus onClick={() => void confirmDelete()}>
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
      <DialogContent aria-describedby={undefined}>
        {/* Corner ⓘ — the fixed dialog anchors it; hover reveals the URL
            examples (no dead zone, copyable text). */}
        <div className="absolute right-3 top-3">
          <TabInfoHint
            label="About server URLs"
            text="Ollama: http://host:11434 · Open WebUI: http://host:8080/api"
          />
        </div>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{server ? "Edit server" : "Add server"}</DialogTitle>
          </DialogHeader>

          <div className="mt-3 space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Name</span>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="…"
              />
            </label>

            <div className="block space-y-1">
              <span className="text-xs text-muted-foreground">Kind</span>
              {/* Two pills instead of a Radix select — the dropdown's value
                  node kept misbehaving in WKWebView (empty label, then a
                  dead trigger after the first pick); these always work. */}
              <div className="flex items-center gap-1.5 pt-0.5" role="radiogroup" aria-label="Server kind">
                <ModePill
                  label="Ollama"
                  active={kind === "ollama"}
                  disabled={false}
                  onClick={() => setKind("ollama")}
                />
                <ModePill
                  label="OpenAI-compatible"
                  active={kind === "openai_compatible"}
                  disabled={false}
                  onClick={() => setKind("openai_compatible")}
                />
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Base URL</span>
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="…"
              />
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

// ---- Allowed tab (issue #28) ---------------------------------------------

/** Corner ⓘ hints per tab: hovering reveals the explainer and it stays open
 * while the pointer travels onto the card, so the text can be copied. */
const TAB_HINTS: Partial<Record<Tab, { label: string; text: string }>> = {
  allowed: {
    label: "About allowed rules",
    text: "A command remembers its programs, and any npm command counts. A file action remembers create and edit rights for every path. Both are permanent, so the agent runs them without asking in every conversation. One-off and conversation-scoped approvals are never part of this list.",
  },
  skills: {
    label: "About skills",
    text: "Enabled skills join system prompts in server-model conversations only — they are never sent to Claude Code or Codex.",
  },
  defaults: {
    label: "About defaults",
    text: "Conversations fall back to these defaults when they have no model of their own.",
  },
};

/** The ⓘ next to the close mark — same ritual as AllowedInfoHint, shared by
 * every tab that has an entry in TAB_HINTS. */
function TabInfoHint({ label, text }: { label: string; text: string }) {
  return (
    <span className="group relative flex" tabIndex={0} aria-label={label}>
      <Info className="h-4 w-4 cursor-help text-muted-foreground transition-colors group-hover:text-foreground" />
      {/* Transparent padding bridges icon and card — no dead zone for the
          pointer; the card itself carries the visible popover styles and
          `select-text` so the copy works. */}
      <span className="pointer-events-none invisible absolute right-0 top-4 z-50 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <span className="block pt-3">
          <span
            role="tooltip"
            className="block w-80 select-text rounded-md border border-border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-md"
          >
            {text}
          </span>
        </span>
      </span>
    </span>
  );
}

/** Icon + label for one allowed-rule kind. */
const ALLOWED_KIND_META: Record<
  AllowedRule["kind"],
  { icon: typeof Terminal; label: string }
> = {
  command: { icon: Terminal, label: "Command" },
  file: { icon: FileText, label: "File" },
  tool: { icon: Wrench, label: "Tool" },
};

function AllowedTab({ open }: { open: boolean }) {
  const [rules, setRules] = useState<AllowedRule[]>([]);
  const [deleting, setDeleting] = useState<AllowedRule | null>(null);

  const loadRules = useCallback(async () => {
    try {
      setRules(await invoke<AllowedRule[]>("list_allowed_commands"));
    } catch (error) {
      console.error("Failed to load allowed commands:", error);
    }
  }, []);

  useEffect(() => {
    if (open) void loadRules();
  }, [open, loadRules]);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await invoke("delete_allowed_command", { id: deleting.id });
      setDeleting(null);
      await loadRules();
    } catch (error) {
      console.error("Failed to delete allowed command:", error);
    }
  };

  return (
    <div className="space-y-3">

      {rules.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          <p>Nothing allowed permanently yet.</p>
          <p className="mt-1">
            Use “Allow permanently” on an agent's permission ask to pin one
            here.
          </p>
        </div>
      ) : (
        <ul className="max-h-64 space-y-2 overflow-y-auto">
          {rules.map((rule) => {
            const meta = ALLOWED_KIND_META[rule.kind] ?? ALLOWED_KIND_META.tool;
            const Icon = meta.icon;
            // File rules store the action (#32) — show it as a phrase, not
            // a bare verb.
            const display =
              rule.kind === "file" ? `${rule.pattern} files` : rule.pattern;
            return (
              <li
                key={rule.id}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
                  title={meta.label}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="w-0 min-w-0 flex-1">
                  <div className="truncate font-mono text-xs">{display}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {meta.label}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleting(rule)}
                  aria-label={`Remove ${display}`}
                  title="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={deleting !== null} onOpenChange={(next) => (!next ? setDeleting(null) : undefined)}>
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Remove allowed rule?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" autoFocus onClick={() => void confirmDelete()}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillsTab({ open }: { open: boolean }) {
  const [skills, setSkills] = useState<StoredSkill[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StoredSkill | null>(null);
  const [deleting, setDeleting] = useState<StoredSkill | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      setSkills(await invoke<StoredSkill[]>("list_skills"));
      // The composer's "/" palette mirrors this library — tell it to reload
      // (the event fires after every mutation path, all of which reload).
      window.dispatchEvent(new Event("klepai:skills-changed"));
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
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Delete skill?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" autoFocus onClick={() => void confirmDelete()}>
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
      <div className="block space-y-1">
        <span className="text-xs text-muted-foreground">Default server</span>
        <Select
          value={settings?.default_server_id != null ? String(settings.default_server_id) : "none"}
          onValueChange={(serverId) =>
            void save(serverId === "none" ? null : Number(serverId), null)
          }
        >
          <SelectTrigger aria-label="Default server" className="py-2 text-sm">
            <SelectValue>
              {settings?.default_server_id != null
                ? servers.find((server) => server.id === settings.default_server_id)?.name ?? "none"
                : "none"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="text-sm">
            <SelectItem value="none">none</SelectItem>
            {servers.map((server) => (
              <SelectItem key={server.id} value={String(server.id)}>
                {server.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="block space-y-1">
        <span className="text-xs text-muted-foreground">Default model</span>
        <div className="relative">
          <Select
            value={settings?.default_model_id ?? "none"}
            disabled={loadingModels || models.length === 0}
            onValueChange={(modelId) =>
              void save(settings?.default_server_id ?? null, modelId === "none" ? null : modelId)
            }
          >
            <SelectTrigger aria-label="Default model" className="py-2 text-sm">
              <SelectValue>
                {settings?.default_model_id ??
                  (loadingModels
                    ? "Loading models…"
                    : models.length === 0
                      ? "No models"
                      : "— none —")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="text-sm">
              <SelectItem value="none">
                {loadingModels ? "Loading models…" : models.length === 0 ? "No models" : "— none —"}
              </SelectItem>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loadingModels && (
            <RefreshCw className="pointer-events-none absolute right-7 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {saved && <p className="text-xs text-primary">Saved.</p>}
    </div>
  );
}

// ---- About tab -------------------------------------------------------------

// UpdatesStatus — the one-line readout under the Check button, one branch per
// UpdateState kind. Error states (including the quiet "not-configured"
// outcome) render their canonical sentence from updater.ts. A missing feed
// ("no-release" — no signed release ships a latest.json yet) reads exactly
// like "up-to-date": to the user the installed build simply is the newest.
function UpdatesStatus({ state, appVersion }: { state: UpdateState; appVersion: string | null }) {
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return <p className="text-xs text-muted-foreground">Checking for updates…</p>;
    case "up-to-date":
    case "no-release":
      return (
        <p className="text-xs text-muted-foreground">
          Klepai is up to date{appVersion != null ? ` (${appVersion})` : ""}.
        </p>
      );
    case "available":
      return (
        <p className="text-xs text-foreground">
          Klepai {state.version} is available
          {appVersion != null ? ` (installed: ${appVersion})` : ""}.
        </p>
      );
    case "downloading":
      return (
        <p className="text-xs text-muted-foreground">
          Downloading update — {downloadProgressText(state.received, state.total)}
        </p>
      );
    case "error":
      return <p className="text-xs text-destructive">{state.message}</p>;
  }
}

function AboutTab() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updates, setUpdates] = useState<UpdateState>({ kind: "idle" });
  // The plugin Update handle for an "available" update — kept in a ref so the
  // render loop never depends on it; only the state machine drives the UI.
  const updateRef = useRef<UpdateResource | null>(null);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(null));
  }, []);

  const checkForUpdates = useCallback(async () => {
    setUpdates({ kind: "checking" });
    try {
      const result = await runCheck(defaultUpdaterApi);
      updateRef.current = result.update;
      setUpdates(result.state);
    } catch (err) {
      setUpdates(
        err instanceof UpdateFlowError
          ? err.state
          : {
              kind: "error",
              errorKind: "unknown",
              message: `Update check failed: ${String(err)}`,
            },
      );
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (update == null) return;
    try {
      await runInstall(defaultUpdaterApi, update, (received, total) =>
        setUpdates({ kind: "downloading", received, total }),
      );
      // Applied — the relaunch below ends this process; keep the last state
      // in case relaunch is blocked (e.g. another install already ran).
      defaultUpdaterApi.relaunch();
    } catch (err) {
      setUpdates(
        err instanceof UpdateFlowError
          ? err.state
          : {
              kind: "error",
              errorKind: "unknown",
              message: `Update install failed: ${String(err)}`,
            },
      );
    }
  }, []);

  const busy = updates.kind === "checking" || updates.kind === "downloading";

  return (
    <div className="flex flex-col items-center gap-1 py-6 text-center">
      <h3 className="font-display text-4xl">KLEPAI</h3>
      <p className="text-sm text-foreground">
        Alpha{appVersion != null ? ` v.${appVersion}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">CrystalPlatforms</p>

      {/* App updates (issue #33): check on demand + one-click install. The
          busy states (checking/downloading) disable both buttons so two
          updates can never race. */}
      <div className="mt-4 flex items-center gap-2">
        {updates.kind === "available" && (
          <Button size="sm" data-testid="update-install" onClick={() => void installUpdate()}>
            Download &amp; restart
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          data-testid="update-check"
          disabled={busy}
          onClick={() => void checkForUpdates()}
        >
          {updates.kind === "checking" && (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
          Check for updates
        </Button>
      </div>
      <div className="mt-1 max-w-sm">
        <UpdatesStatus state={updates} appVersion={appVersion} />
      </div>
    </div>
  );
}
