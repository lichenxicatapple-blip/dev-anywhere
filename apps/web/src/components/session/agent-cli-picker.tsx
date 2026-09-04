import type { AgentCliStatus } from "@dev-anywhere/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RemotePathSelector } from "@/components/path/remote-path-selector";
import { type ProviderId, PROVIDER_LABEL } from "./create-session-submit";

const PROVIDERS = ["claude", "codex", "kimi"] as const satisfies readonly ProviderId[];

interface AgentCliPickerProps {
  agentCli: AgentCliStatus | null;
  provider: ProviderId;
  cliPathDraftProvider: ProviderId | null;
  cliPathDraft: string;
  savingCliPath: boolean;
  onProviderChange: (provider: ProviderId) => void;
  onCliPathDraftChange: (provider: ProviderId, value: string) => void;
  onDiscardCliPathDraft: () => void;
  onSaveCliPath: () => void;
}

export function AgentCliPicker({
  agentCli,
  provider,
  cliPathDraftProvider,
  cliPathDraft,
  savingCliPath,
  onProviderChange,
  onCliPathDraftChange,
  onDiscardCliPathDraft,
  onSaveCliPath,
}: AgentCliPickerProps) {
  const selectedCli = agentCli?.[provider];
  const selectedPath = selectedCli?.command ?? "";
  const hasDraft = cliPathDraftProvider === provider;
  const pathValue = hasDraft ? cliPathDraft : selectedPath;
  const pathChanged = hasDraft && cliPathDraft.trim() !== selectedPath;

  return (
    <section aria-label="Agent CLI" className="flex min-w-0 flex-col gap-2">
      <span className="text-sm">Agent CLI</span>
      <Select
        value={provider}
        disabled={savingCliPath}
        onValueChange={(value) => onProviderChange(value as ProviderId)}
      >
        <SelectTrigger
          className="min-h-11 w-full md:min-h-0"
          aria-label="Agent CLI"
          data-slot="agent-cli-provider-select"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-slot="agent-cli-provider-options">
          {PROVIDERS.map((option) => (
            <SelectItem key={option} value={option} className="min-h-11 md:min-h-0">
              {PROVIDER_LABEL[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative min-w-0" data-slot="agent-cli-path-card">
        <RemotePathSelector
          key={provider}
          id={`agent-cli-path-${provider}`}
          data-slot="agent-cli-path"
          label="CLI 路径"
          value={pathValue}
          onValueChange={(path) => onCliPathDraftChange(provider, path)}
          selectionKind="file"
          includeHidden
          disabled={savingCliPath}
          placeholder="选择 CLI 可执行文件"
          labelActions={
            pathChanged ? (
              <div className="flex items-center gap-4" data-slot="agent-cli-path-actions">
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center px-0 text-xs font-medium text-muted-foreground hover:underline focus-visible:underline focus-visible:outline-none disabled:cursor-not-allowed disabled:no-underline md:min-h-8 md:min-w-0"
                  onClick={onDiscardCliPathDraft}
                  disabled={savingCliPath}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center px-0 text-xs font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline md:min-h-8 md:min-w-0"
                  onClick={onSaveCliPath}
                  disabled={savingCliPath || !cliPathDraft.trim()}
                >
                  {savingCliPath ? "保存中..." : "保存"}
                </button>
              </div>
            ) : undefined
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && pathChanged) {
              event.preventDefault();
              event.stopPropagation();
              onSaveCliPath();
            }
            if (event.key === "Escape" && hasDraft) {
              event.preventDefault();
              event.stopPropagation();
              onDiscardCliPathDraft();
            }
          }}
        />
        {selectedCli?.error && !pathChanged ? (
          <p className="mt-1 break-all text-xs text-destructive">{selectedCli.error}</p>
        ) : null}
      </div>
    </section>
  );
}
