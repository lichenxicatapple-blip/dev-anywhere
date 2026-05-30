import { PencilLine } from "lucide-react";
import type { AgentCliStatus } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type ProviderId,
  PROVIDER_LABEL,
  providerStatus,
  providerTooltip,
} from "./create-session-submit";

interface AgentCliPickerProps {
  agentCli: AgentCliStatus | null;
  provider: ProviderId;
  isDesktop: boolean;
  editingCliProvider: ProviderId | null;
  cliPathInput: string;
  savingCliPath: boolean;
  onProviderChange: (provider: ProviderId) => void;
  onOpenCliPathEditor: (provider: ProviderId) => void;
  onCliPathInputChange: (value: string) => void;
  onCancelCliPathEditor: () => void;
  onSaveCliPath: () => void;
}

export function AgentCliPicker({
  agentCli,
  provider,
  isDesktop,
  editingCliProvider,
  cliPathInput,
  savingCliPath,
  onProviderChange,
  onOpenCliPathEditor,
  onCliPathInputChange,
  onCancelCliPathEditor,
  onSaveCliPath,
}: AgentCliPickerProps) {
  const claudeStatus = providerStatus("claude", agentCli);
  const codexStatus = providerStatus("codex", agentCli);
  const selectedCli = agentCli?.[provider];

  return (
    <section aria-label="Agent CLI" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm">Agent CLI</span>
        <span className="text-xs text-muted-foreground">选择要启动的 CLI</span>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <ProviderButton
          provider="claude"
          selected={provider === "claude"}
          status={claudeStatus}
          agentCliLoaded={Boolean(agentCli)}
          onClick={() => onProviderChange("claude")}
        />
        <ProviderButton
          provider="codex"
          selected={provider === "codex"}
          status={codexStatus}
          agentCliLoaded={Boolean(agentCli)}
          onClick={() => onProviderChange("codex")}
        />
      </div>
      <div
        className="relative min-w-0 rounded-md border border-border bg-muted/20 px-3 py-2.5 md:p-3"
        data-slot="agent-cli-path-card"
      >
        {editingCliProvider === provider ? (
          <AgentCliPathEditor
            provider={editingCliProvider}
            agentCli={agentCli}
            cliPathInput={cliPathInput}
            savingCliPath={savingCliPath}
            onCliPathInputChange={onCliPathInputChange}
            onCancel={onCancelCliPathEditor}
            onSave={onSaveCliPath}
          />
        ) : (
          <AgentCliPathDisplay
            provider={provider}
            selectedCli={selectedCli}
            isDesktop={isDesktop}
            onOpenCliPathEditor={onOpenCliPathEditor}
          />
        )}
      </div>
    </section>
  );
}

function ProviderButton({
  provider,
  selected,
  status,
  agentCliLoaded,
  onClick,
}: {
  provider: ProviderId;
  selected: boolean;
  status: ReturnType<typeof providerStatus>;
  agentCliLoaded: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={selected}
          aria-label={PROVIDER_LABEL[provider]}
          onClick={onClick}
          className={cn(
            "flex min-h-14 min-w-0 flex-col items-start justify-center gap-1 rounded-md border px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "border-primary/70 bg-primary/10" : "border-border bg-muted/20",
          )}
        >
          <span className="text-sm font-medium">{PROVIDER_LABEL[provider]}</span>
          <span
            className={cn(
              "text-xs text-muted-foreground",
              status.disabled && agentCliLoaded && "text-destructive",
            )}
          >
            {status.label}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[min(520px,calc(100vw-2rem))]">
        <span className="break-all font-mono text-xs">{providerTooltip(provider, status)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function AgentCliPathEditor({
  provider,
  agentCli,
  cliPathInput,
  savingCliPath,
  onCliPathInputChange,
  onCancel,
  onSave,
}: {
  provider: ProviderId;
  agentCli: AgentCliStatus | null;
  cliPathInput: string;
  savingCliPath: boolean;
  onCliPathInputChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <>
      <p className="mb-1 text-xs text-muted-foreground">CLI 路径</p>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <label className="min-w-0 flex-1">
          <span className="sr-only">CLI 路径</span>
          <input
            type="text"
            list={`agent-cli-path-${provider}`}
            value={cliPathInput}
            onChange={(event) => onCliPathInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSave();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
            }}
            placeholder={
              provider === "claude" ? "/home/dev/.local/bin/claude" : "/home/dev/.local/bin/codex"
            }
            className="min-h-11 w-full rounded-md border border-border bg-input px-3 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-10 md:min-h-0 md:text-sm"
          />
          <datalist id={`agent-cli-path-${provider}`}>
            {(agentCli?.[provider].suggestions ?? []).map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </label>
        <div className="flex shrink-0 justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 shrink-0 rounded px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground md:h-8 md:min-h-0"
            onClick={onCancel}
            disabled={savingCliPath}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 shrink-0 rounded px-2.5 text-xs font-medium md:h-8 md:min-h-0"
            onClick={onSave}
            disabled={savingCliPath || !cliPathInput.trim()}
          >
            {savingCliPath ? "保存中..." : "保存路径"}
          </Button>
        </div>
      </div>
    </>
  );
}

function AgentCliPathDisplay({
  provider,
  selectedCli,
  isDesktop,
  onOpenCliPathEditor,
}: {
  provider: ProviderId;
  selectedCli: AgentCliStatus[ProviderId] | undefined;
  isDesktop: boolean;
  onOpenCliPathEditor: (provider: ProviderId) => void;
}) {
  if (!isDesktop) {
    return (
      <>
        <p className="pr-11 text-xs text-muted-foreground">CLI 路径</p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 size-11 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-accent/70 hover:text-foreground"
          aria-label="指定路径"
          onClick={() => onOpenCliPathEditor(provider)}
        >
          <PencilLine className="size-4" aria-hidden="true" />
        </Button>
        <p
          className={cn(
            "mt-1 min-w-0 break-all pr-11 font-mono text-sm leading-5",
            selectedCli?.available ? "text-foreground" : "text-destructive",
          )}
          title={selectedCli?.command ?? selectedCli?.error}
        >
          {selectedCli?.command ?? selectedCli?.error ?? "等待检测结果"}
        </p>
      </>
    );
  }

  return (
    <>
      <p className="mb-1 text-xs text-muted-foreground">CLI 路径</p>
      <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
        <p
          className={cn(
            "flex h-10 min-w-0 flex-1 items-center truncate font-mono text-sm",
            selectedCli?.available ? "text-foreground" : "text-destructive",
          )}
          title={selectedCli?.command ?? selectedCli?.error}
        >
          {selectedCli?.command ?? selectedCli?.error ?? "等待检测结果"}
        </p>
        <Button
          type="button"
          variant="outline"
          className="h-8 min-h-0 shrink-0 self-end rounded px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground sm:self-auto"
          onClick={() => onOpenCliPathEditor(provider)}
        >
          指定路径
        </Button>
      </div>
    </>
  );
}
