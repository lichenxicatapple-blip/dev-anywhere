import "./status-line.css";

interface PtyApprovalHintProps {
  autoYesEnabled: boolean;
  onAutoYesChange: (enabled: boolean) => void;
}

export function PtyApprovalHint({ autoYesEnabled, onAutoYesChange }: PtyApprovalHintProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="等待审批"
      data-slot="pty-approval-hint"
      className="dev-pty-approval-hint"
    >
      <span className="dev-pty-approval-hint-label">等待审批</span>
      <button
        type="button"
        aria-pressed={autoYesEnabled}
        className="dev-pty-approval-auto-yes"
        onClick={() => onAutoYesChange(!autoYesEnabled)}
      >
        Always yes
      </button>
    </div>
  );
}
