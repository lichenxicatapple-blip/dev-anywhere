// 工具审批卡片，显示工具名、参数预览和三个操作按钮
import { useState } from "react";
import { View, Text } from "@tarojs/components";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { summarizeToolInput } from "@/utils/summarize-tool-input";
import "./index.css";

interface ToolApprovalCardProps {
  approval: ToolApprovalRequest;
  onAllow: () => void;
  onAllowAll: () => void;
  onDeny: () => void;
  sessionMode: "pty" | "json";
}

export function ToolApprovalCard({
  approval,
  onAllow,
  onAllowAll,
  onDeny,
}: ToolApprovalCardProps) {
  const [acted, setActed] = useState(false);
  const summary = summarizeToolInput(approval.toolName, approval.input);
  const isResolved = approval.status !== "pending";

  const handleAction = (action: () => void) => {
    if (acted || isResolved) return;
    setActed(true);
    action();
  };

  if (isResolved) {
    if (approval.status === "denied") {
      return (
        <View className="tool-approval-card tool-approval-resolved">
          <View className="tool-approval-denied-marker">
            <Text className="tool-approval-denied-text">Denied: {approval.toolName}</Text>
          </View>
        </View>
      );
    }
    // approved: 折叠为 ToolCallCard 样式
    return (
      <View className="tool-approval-card tool-approval-resolved">
        <View className="tool-approval-approved-row">
          <Text className="tool-approval-approved-icon">&#9874;</Text>
          <Text className="tool-approval-approved-name">{approval.toolName}</Text>
          <Text className="tool-approval-approved-summary">{summary.summary}</Text>
        </View>
      </View>
    );
  }

  const buttonsDisabled = acted || isResolved;

  return (
    <View className="tool-approval-card">
      <Text className="tool-approval-title">Need Tool Approval</Text>
      <Text className="tool-approval-tool-name">{approval.toolName}</Text>

      <View className="tool-approval-preview">
        {summary.type === "edit" && (
          <EditPreview details={summary.details as { old_string?: string; new_string?: string }} />
        )}
        {summary.type === "bash" && <BashPreview command={summary.summary} />}
        {summary.type === "write" && (
          <WritePreview filePath={summary.summary} content={(summary.details as { content?: string }).content || ""} />
        )}
        {summary.type === "generic" && <GenericPreview json={summary.summary} />}
      </View>

      <View className="tool-approval-buttons">
        <View
          className={`tool-approval-btn tool-approval-btn-allow ${buttonsDisabled ? "tool-approval-btn-disabled" : ""}`}
          onClick={() => handleAction(onAllow)}
        >
          <Text className="tool-approval-btn-text-light">Allow</Text>
        </View>
        <View
          className={`tool-approval-btn tool-approval-btn-allow-all ${buttonsDisabled ? "tool-approval-btn-disabled" : ""}`}
          onClick={() => handleAction(onAllowAll)}
        >
          <Text className="tool-approval-btn-text-light">Allow All</Text>
        </View>
        <View
          className={`tool-approval-btn tool-approval-btn-deny ${buttonsDisabled ? "tool-approval-btn-disabled" : ""}`}
          onClick={() => handleAction(onDeny)}
        >
          <Text className="tool-approval-btn-text-deny">Deny</Text>
        </View>
      </View>
    </View>
  );
}

function EditPreview({ details }: { details: { old_string?: string; new_string?: string } }) {
  return (
    <View className="tool-preview-edit">
      {details.old_string != null && (
        <Text selectable className="tool-preview-edit-remove">
          - {String(details.old_string).slice(0, 200)}
        </Text>
      )}
      {details.new_string != null && (
        <Text selectable className="tool-preview-edit-add">
          + {String(details.new_string).slice(0, 200)}
        </Text>
      )}
    </View>
  );
}

function BashPreview({ command }: { command: string }) {
  return (
    <View className="tool-preview-bash">
      <Text selectable className="tool-preview-bash-prompt">$ </Text>
      <Text selectable className="tool-preview-bash-cmd">{command}</Text>
    </View>
  );
}

function WritePreview({ filePath, content }: { filePath: string; content: string }) {
  return (
    <View className="tool-preview-write">
      <Text selectable className="tool-preview-write-path">{filePath}</Text>
      {content && (
        <Text selectable className="tool-preview-write-content">{content.slice(0, 200)}</Text>
      )}
    </View>
  );
}

function GenericPreview({ json }: { json: string }) {
  return (
    <View className="tool-preview-generic">
      <Text selectable className="tool-preview-generic-text">{json}</Text>
    </View>
  );
}
