import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Loader2, PanelRightClose } from "lucide-react";

import type { AppSettings, Conversation, ModelInfo, Server } from "@/types";
import { Button } from "@/components/ui/button";
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
      <select
        aria-label="Model"
        value={value ?? ""}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full appearance-none rounded-md border border-input bg-input px-2 py-1.5 text-xs outline-none disabled:opacity-50"
      >
        <option value="">{loading ? "Loading models…" : fallbackLabel}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.id}
          </option>
        ))}
      </select>
      {loading && (
        <Loader2 className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
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

          {/* The brain: a server model or one of the headless CLIs — the
              mode decides how much of the computer it may touch. */}
          <Row label="Brain">
            <select
              aria-label="Brain"
              value={conversation?.agent_kind ?? "server"}
              disabled={!conversation}
              onChange={(event) => void switchBrain(event.target.value)}
              className="w-full appearance-none rounded-md border border-input bg-input px-2 py-1.5 outline-none disabled:opacity-50"
            >
              <option value="server">Server model</option>
              <option value="claude_code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
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
            <select
              aria-label="Server"
              value={conversation?.server_id ?? ""}
              disabled={!conversation || servers.length === 0}
              onChange={(event) => {
                const serverId = event.target.value ? Number(event.target.value) : null;
                // Switching servers invalidates the pinned model.
                void applySelection(serverId, null);
                setModels([]);
              }}
              className="w-full appearance-none rounded-md border border-input bg-input px-2 py-1.5 outline-none disabled:opacity-50"
            >
              <option value="">{fallbackLabel}</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
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
                <select
                  aria-label="System prompt mode"
                  value={sysMode}
                  onChange={(event) => {
                    const mode = event.target.value === "custom" ? "custom" : "default";
                    setSysMode(mode);
                    if (mode === "default") {
                      // Leaving Custom clears the prompt right away.
                      void commitSettings({ ...draft, systemPrompt: "" });
                    }
                  }}
                  className="w-full appearance-none rounded-md border border-input bg-input px-2 py-1.5 outline-none"
                >
                  <option value="default">Use default</option>
                  <option value="custom">Custom…</option>
                </select>
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
