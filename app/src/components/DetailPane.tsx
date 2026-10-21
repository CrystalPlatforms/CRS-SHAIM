import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Loader2, PanelRightClose } from "lucide-react";

import type { AppSettings, Conversation, Message, ModelInfo, Server } from "@/types";
import {
  EXPORT_FORMATS,
  buildExportFile,
  bytesToBase64,
  type ExportFormat,
} from "@/lib/chatExport";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModePill } from "@/components/ChatPane";
import { cn } from "@/lib/utils";

interface DetailPaneProps {
  conversation: Conversation | null;
  open: boolean;
  onClose: () => void;
  /** Notifies the parent that the conversation record changed. */
  onConversationsChanged: () => void;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function ModelSelect({
  value,
  models,
  loading,
  disabled,
  fallbackLabel,
  onChange,
}: {
  value: string | null;
  models: ModelInfo[];
  loading: boolean;
  disabled: boolean;
  fallbackLabel: string;
  onChange: (modelId: string | null) => void;
}) {
  return (
    <div className="relative">
      <Select
        value={value ?? undefined}
        disabled={disabled || loading}
        onValueChange={(modelId) => onChange(modelId)}
      >
        <SelectTrigger aria-label="Model">
          {/* Radix only portals the selected item's text while the list is
              open — the current label travels as children so the closed
              trigger never goes blank. */}
          <SelectValue placeholder={loading ? "Loading models…" : fallbackLabel}>
            {value ?? undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {models.length === 0 ? (
            <SelectItem value="placeholder" disabled>
              {loading ? "Loading models…" : fallbackLabel}
            </SelectItem>
          ) : (
            models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.id}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {loading && (
        <Loader2 className="pointer-events-none absolute right-7 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}

/** Draft of the per-conversation chat settings; empty text means "unset". */
interface SettingsDraft {
  systemPrompt: string;
  temperature: string;
  contextLen: string;
}

/** "Use default" sends no system prompt; "Custom…" reveals the textarea. */
type SystemPromptMode = "default" | "custom";

const draftOf = (conversation: Conversation | null): SettingsDraft => ({
  systemPrompt: conversation?.system_prompt ?? "",
  temperature: conversation?.temperature?.toString() ?? "",
  contextLen: conversation?.context_len?.toString() ?? "",
});

const promptModeOf = (conversation: Conversation | null): SystemPromptMode =>
  conversation?.system_prompt ? "custom" : "default";

/**
 * Stays mounted so the width transition can animate both directions;
 * the fixed-width inner keeps content from squishing while sliding.
 */
export function DetailPane({
  conversation,
  open,
  onClose,
  onConversationsChanged,
}: DetailPaneProps) {
  const [servers, setServers] = useState<Server[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(conversation));
  const [sysMode, setSysMode] = useState<SystemPromptMode>(() => promptModeOf(conversation));
  /** A failed brain switch — shown instead of silently reverting. */
  const [brainError, setBrainError] = useState<string | null>(null);
  /** The export currently building — buttons show a spinner, stay enabled
   * for the others; null means no export is running (issue #25). */
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  /** Remounts the export launcher after each pick so it snaps back to the
   * placeholder instead of showing the chosen format as a setting. */
  const [exportNonce, setExportNonce] = useState(0);

  // Re-read the settings draft whenever another conversation is selected.
  useEffect(() => {
    setDraft(draftOf(conversation));
    setSysMode(promptModeOf(conversation));
  }, [conversation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The effective fallback for "Use default": the conversation's pin, then
  // the Settings default, then simply the first server on the list.
  const activeServerId =
    conversation?.server_id ??
    settings?.default_server_id ??
    servers[0]?.id ??
    null;
  const fallbackServer = servers.find((s) => s.id === activeServerId) ?? null;
  const fallbackLabel = fallbackServer
    ? `Use default (${fallbackServer.name})`
    : "Use default";
  // The model picker's fallback shows the default *model*, not the server.
  const modelFallbackLabel = settings?.default_model_id
    ? `Use default (${settings.default_model_id})`
    : "Use default";

  const loadServers = useCallback(async () => {
    try {
      const [serverList, currentSettings] = await Promise.all([
        invoke<Server[]>("list_servers"),
        invoke<AppSettings>("get_settings"),
      ]);
      setServers(serverList);
      setSettings(currentSettings);
    } catch (error) {
      console.error("Failed to load servers:", error);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers, open]);

  // Settings → Servers may add/edit/delete while Details stays open — the
  // window event keeps the Server dropdown current without a reopen.
  useEffect(() => {
    const onServersChanged = () => void loadServers();
    window.addEventListener("shaim:servers-changed", onServersChanged);
    return () =>
      window.removeEventListener("shaim:servers-changed", onServersChanged);
  }, [loadServers]);

  // Fetch the model list for whichever server is in play. Re-runs when the
  // server row changes, so an edited/fixed server refreshes without a restart.
  useEffect(() => {
    if (!open || activeServerId === null) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoadingModels(true);
    invoke<ModelInfo[]>("list_server_models", { id: activeServerId })
      .then((loaded) => {
        if (!cancelled) setModels(loaded);
      })
      .catch((error) => {
        console.error("Failed to load models:", error);
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeServerId, servers]);

  const applySelection = async (serverId: number | null, modelId: string | null) => {
    if (!conversation) return;
    try {
      await invoke("set_conversation_model", {
        id: conversation.id,
        serverId,
        modelId,
      });
      onConversationsChanged();
    } catch (error) {
      console.error("Failed to set conversation model:", error);
    }
  };

  /**
   * Persists the whole settings block in one call. The text fields commit on
   * blur / Enter. Reasoning is always on — there is no toggle to commit.
   */
  const commitSettings = useCallback(
    async (next: SettingsDraft) => {
      if (!conversation) return;
      const temperature = next.temperature.trim();
      const contextLen = next.contextLen.trim();
      try {
        await invoke("set_conversation_settings", {
          id: conversation.id,
          systemPrompt: next.systemPrompt.trim().length > 0 ? next.systemPrompt : null,
          temperature: temperature.length > 0 ? Number(temperature) : null,
          contextLen: contextLen.length > 0 ? Number(contextLen) : null,
        });
        onConversationsChanged();
      } catch (error) {
        console.error("Failed to save conversation settings:", error);
      }
    },
    [conversation, onConversationsChanged],
  );

  /** Switches Natural ↔ Agent immediately — the folder is changed from
   * the folder row below, no setup dialog. */
  const switchMode = useCallback(
    async (mode: string) => {
      if (!conversation || conversation.mode === mode) return;
      try {
        await invoke("set_conversation_mode", { id: conversation.id, mode });
        onConversationsChanged();
      } catch (error) {
        console.error("Failed to switch mode:", error);
      }
    },
    [conversation, onConversationsChanged],
  );

  /** Repoints the project folder via the native picker. */
  const changeFolder = useCallback(async () => {
    if (!conversation) return;
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string" || picked.length === 0) return;
      await invoke("set_conversation_agent", {
        id: conversation.id,
        agentKind: conversation.agent_kind,
        projectPath: picked,
      });
      onConversationsChanged();
    } catch (error) {
      console.error("Failed to change folder:", error);
    }
  }, [conversation, onConversationsChanged]);

  /** Swaps the brain between a server model and the CLI agents. A failed
   * save is loud — a silent revert would look like the app ignoring you. */
  const switchBrain = useCallback(
    async (brain: string) => {
      if (!conversation) return;
      setBrainError(null);
      try {
        await invoke("set_conversation_brain", {
          id: conversation.id,
          agentKind: brain === "server" ? null : brain,
        });
        onConversationsChanged();
      } catch (error) {
        setBrainError(String(error));
        console.error("Failed to switch brain:", error);
      }
    },
    [conversation, onConversationsChanged],
  );

  /** Exports the conversation (issue #25): pulls the full history, builds
   * the chosen document in the webview, asks where to save it and writes
   * it through the save_export command. Cancelling the dialog is a no-op. */
  const runExport = useCallback(
    async (format: ExportFormat) => {
      if (!conversation) return;
      setExporting(format);
      setExportError(null);
      try {
        const history = await invoke<Message[]>("list_messages", {
          conversationId: conversation.id,
        });
        const spec = EXPORT_FORMATS.find((entry) => entry.format === format);
        const file = buildExportFile(conversation.title, history, format);
        const picked = await saveDialog({
          defaultPath: file.filename,
          filters: spec
            ? [{ name: spec.filterName, extensions: [spec.extension] }]
            : undefined,
        });
        if (typeof picked !== "string" || picked.length === 0) return;
        await invoke("save_export", {
          path: picked,
          dataBase64: bytesToBase64(file.bytes),
        });
      } catch (error) {
        setExportError(String(error));
        console.error("Failed to export chat:", error);
      } finally {
        setExporting(null);
      }
    },
    [conversation],
  );

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out",
        open ? "w-64" : "w-0"
      )}
    >
      <div
        className={cn(
          "flex h-full w-64 flex-col border-l border-sidebar-border bg-sidebar",
          !open && "pointer-events-none"
        )}
      >
        <header className="flex items-center px-4 py-2.5">
          <h2 className="text-sm font-semibold">Details</h2>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto text-muted-foreground"
            onClick={onClose}
            aria-label="Hide details"
            title="Hide details"
          >
            <PanelRightClose />
          </Button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          <Row label="Mode">
            <div className="flex items-center gap-1.5">
              <ModePill
                label="Natural"
                active={conversation?.mode !== "agent"}
                disabled={!conversation}
                onClick={() => void switchMode("natural")}
              />
              <ModePill
                label="Agent"
                active={conversation?.mode === "agent"}
                disabled={!conversation}
                onClick={() => void switchMode("agent")}
              />
            </div>
          </Row>

          {/* Export the whole chat (issue #25): one dropdown above Brain —
              picking a format builds the file in the webview and opens the
              native save dialog. The key remount snaps the launcher back
              to its placeholder; it is not a setting. */}
          <Row label="Export">
            <Select
              key={exportNonce}
              disabled={!conversation || exporting !== null}
              onValueChange={(format) => {
                setExportNonce((nonce) => nonce + 1);
                if (format) void runExport(format as ExportFormat);
              }}
            >
              <SelectTrigger aria-label="Export chat as">
                <SelectValue placeholder={exporting ? "Exporting…" : "Export chat…"} />
              </SelectTrigger>
              <SelectContent>
                {EXPORT_FORMATS.map(({ format, label, extension }) => (
                  <SelectItem key={format} value={format}>
                    {label} (.{extension})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {exportError && (
              <p className="pt-1 text-[11px] text-destructive" role="alert">
                {exportError}
              </p>
            )}
          </Row>

          {/* The brain: a server model or one of the headless CLIs — the
              mode decides how much of the computer it may touch. */}
          <Row label="Brain">
            <Select
              value={conversation?.agent_kind ?? "server"}
              disabled={!conversation}
              onValueChange={(brain) => void switchBrain(brain)}
            >
              <SelectTrigger aria-label="Brain">
                <SelectValue>
                  {conversation?.agent_kind === "claude_code"
                    ? "Claude Code"
                    : conversation?.agent_kind === "codex"
                      ? "Codex"
                      : "Server model"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="server">Server model</SelectItem>
                <SelectItem value="claude_code">Claude Code</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
              </SelectContent>
            </Select>
          </Row>

          {brainError && (
            <p className="text-[11px] text-destructive" role="alert">
              {brainError}
            </p>
          )}

          {conversation?.agent_kind != null ? (
            <>
              {conversation.mode === "agent" && (
                <>
                  <Row label="Project folder">
                    <div className="break-all font-mono text-[11px] text-muted-foreground">
                      {conversation.project_path ?? "—"}
                    </div>
                  </Row>
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => void changeFolder()}
                    >
                      Change folder…
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <Row label="Server">
            <Select
              value={conversation?.server_id != null ? String(conversation.server_id) : undefined}
              disabled={!conversation || servers.length === 0}
              onValueChange={(serverId) => {
                // Switching servers invalidates the pinned model.
                void applySelection(Number(serverId), null);
                setModels([]);
              }}
            >
              <SelectTrigger aria-label="Server">
                <SelectValue placeholder={fallbackLabel}>
                  {conversation?.server_id != null
                    ? servers.find((server) => server.id === conversation.server_id)?.name
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {servers.map((server) => (
                  <SelectItem key={server.id} value={String(server.id)}>
                    {server.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row label="Model">
            <ModelSelect
              value={conversation?.model_id ?? null}
              models={models}
              loading={loadingModels}
              disabled={!conversation}
              fallbackLabel={modelFallbackLabel}
              onChange={(modelId) => void applySelection(activeServerId, modelId)}
            />
          </Row>

          {conversation && (
            <>
              <Row label="System prompt">
                <Select
                  value={sysMode}
                  onValueChange={(mode) => {
                    const next = mode === "custom" ? "custom" : "default";
                    setSysMode(next);
                    if (next === "default") {
                      // Leaving Custom clears the prompt right away.
                      void commitSettings({ ...draft, systemPrompt: "" });
                    }
                  }}
                >
                  <SelectTrigger aria-label="System prompt mode">
                    <SelectValue>
                      {sysMode === "custom" ? "Custom…" : "Use default"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Use default</SelectItem>
                    <SelectItem value="custom">Custom…</SelectItem>
                  </SelectContent>
                </Select>
                {sysMode === "custom" && (
                  <textarea
                    aria-label="System prompt"
                    rows={3}
                    autoFocus
                    value={draft.systemPrompt}
                    placeholder="Instructions for the model…"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        systemPrompt: event.target.value,
                      }))
                    }
                    onBlur={() => void commitSettings(draft)}
                    className="w-full resize-y rounded-md border border-input bg-input px-2 py-1.5 outline-none placeholder:text-muted-foreground"
                  />
                )}
              </Row>

              <Row label="Temperature">
                <input
                  aria-label="Temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperature}
                  disabled={!conversation}
                  placeholder="Model default"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      temperature: event.target.value,
                    }))
                  }
                  onBlur={() => void commitSettings(draft)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  className="w-full rounded-md border border-input bg-input px-2 py-1.5 outline-none placeholder:text-muted-foreground"
                />
              </Row>

              <Row label="Context length">
                <input
                  aria-label="Context length"
                  type="number"
                  min={0}
                  step={512}
                  value={draft.contextLen}
                  disabled={!conversation}
                  placeholder="Model default"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      contextLen: event.target.value,
                    }))
                  }
                  onBlur={() => void commitSettings(draft)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                  className="w-full rounded-md border border-input bg-input px-2 py-1.5 outline-none placeholder:text-muted-foreground"
                />
              </Row>
            </>
          )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
