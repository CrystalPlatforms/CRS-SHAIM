import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, PanelRightClose } from "lucide-react";

import type { AppSettings, Conversation, ModelInfo, Server } from "@/types";
import { Button } from "@/components/ui/button";
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

        <div className="space-y-3 p-4 text-xs">
          <Row label="Mode">
            <div className="text-foreground">
              {conversation
                ? conversation.mode.charAt(0).toUpperCase() + conversation.mode.slice(1)
                : "—"}
            </div>
          </Row>

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
        </div>
      </div>
    </aside>
  );
}
