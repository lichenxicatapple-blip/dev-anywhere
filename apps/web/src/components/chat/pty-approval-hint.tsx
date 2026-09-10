import "./status-line.css";

interface PtyApprovalHintProps {
  autoYesEnabled: boolean;
  onAutoYesChange: (enabled: boolean) => void;
  kind?: "approval" | "input";
}

export function PtyApprovalHint({
  autoYesEnabled,
  onAutoYesChange,
  kind = "approval",
}: PtyApprovalHintProps) {
  const label = kind === "input" ? "等待输入" : "等待审批";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      data-slot="pty-approval-hint"
      className="dev-pty-approval-hint"
    >
      <span className="dev-pty-approval-hint-label">{label}</span>
      {kind === "approval" && (
        <button
          type="button"
          aria-pressed={autoYesEnabled}
          className="dev-pty-approval-auto-yes"
          onClick={() => onAutoYesChange(!autoYesEnabled)}
        >
          Always yes
        </button>
      )}
    </div>
  );
}
