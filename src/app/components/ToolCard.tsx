import { useState, type ReactNode } from "react";

type ToolStatus = "running" | "success" | "error";

interface ToolCardProps {
  toolName: string;
  status: ToolStatus;
  input?: Record<string, unknown>;
  result?: unknown;
  summary?: string;
  error?: string | null;
  children?: ReactNode;
}

function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export default function ToolCard({
  toolName,
  status,
  input,
  result,
  summary,
  error,
  children,
}: ToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const statusLabel = {
    running: "进行中...",
    success: "✅ 完成",
    error: "❌ 失败",
  }[status];

  const canExpand = status !== "running";

  return (
    <div className={`tool-card tool-card-${status}`}>
      <div
        className="card-header tool-header"
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
        style={{ cursor: canExpand ? "pointer" : "default" }}
      >
        <div className="card-header-left">
          <span className="tool-icon">🔧</span>
          <span className="tool-name">{toolName}</span>
        </div>
        <div className="card-header-right">
          <span className="tool-status">{statusLabel}</span>
          {canExpand && <span className="expand-icon">{isExpanded ? "▲ 收起" : "▼ 展开"}</span>}
        </div>
      </div>
      <div className={`card-body tool-body ${isExpanded ? "expanded" : ""}`}>
        <div className="card-body-inner">
          <div>
            {/* Observations shown inside the card when running */}
            {status === "running" && children && <div className="tool-children">{children}</div>}
            {status === "success" && <div className="tool-summary">{summary}</div>}
            {status === "error" && error && <div className="tool-error">{error}</div>}
            {isExpanded && (
              <>
                {children && status !== "running" && (
                  <div className="tool-children">
                    <div className="tool-children-content">{children}</div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
