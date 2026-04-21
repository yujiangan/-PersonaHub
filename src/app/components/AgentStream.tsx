import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Pluggable } from "unified";
import ThinkingCard from "./ThinkingCard";
import ToolCard from "./ToolCard";
import ObservationLine from "./ObservationLine";
import GeneratingHint from "./GeneratingHint";
import type { AgentEvent } from "../hooks/useAnalysis";
import "./agent-stream.css";

interface AgentStreamProps {
  finalReport: string;
  isDone: boolean;
  error: string | null;
  isGeneratingReport: boolean;
  events: AgentEvent[];
  observationsByTool?: Record<string, AgentEvent[]>;
}

function FinalReport({ report }: { report: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("复制失败:", err);
    }
  };

  // 预处理 markdown，修复表格格式问题
  return (
    <div className="final-report-container">
      <div className="reply-block">
        <div className="copy-button-wrapper">
          <button onClick={handleCopy} className={`copy-button ${copied ? "copied" : ""}`}>
            {copied ? "✓ 已复制" : "📋 复制报告"}
          </button>
        </div>
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm as Pluggable]}>{report}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function EventRenderer({
  event,
  observations,
}: {
  event: AgentEvent;
  observations?: AgentEvent[];
}) {
  switch (event.type) {
    case "thinking":
      if (event.content == null) return null;
      return <ThinkingCard content={event.content} />;

    case "tool_start":
      if (event.toolName == null) return null;
      return <ToolCard toolName={event.toolName} status="running" />;

    case "tool_end":
      if (event.toolName == null) return null;
      // Only show the last observation (the result), not loading messages
      const lastObservation =
        observations && observations.length > 0 ? observations[observations.length - 1] : undefined;
      return (
        <ToolCard
          toolName={event.toolName}
          status={event.toolSuccess ? "success" : "error"}
          result={event.toolResult}
          summary={event.toolSummary}
          error={event.toolError}
        >
          {lastObservation && (
            <div className="tool-observation-inline">
              <ObservationLine content={lastObservation.content || ""} />
            </div>
          )}
        </ToolCard>
      );

    case "observation":
      // Observations are shown inside tool_end cards
      return null;

    default:
      return null;
  }
}

export default function AgentStream({
  finalReport,
  isDone,
  error,
  isGeneratingReport,
  events,
  observationsByTool = {},
}: AgentStreamProps) {
  if (!finalReport && !error && events.length === 0) return null;

  return (
    <div className="agent-stream">
      {error && <div className="error-block">❌ {error}</div>}

      <div className="events-container">
        {events.map((event) => {
          // For tool_end events, get associated observations
          const obs = event.toolCallId ? observationsByTool[event.toolCallId] : undefined;
          return (
            <div key={event.id} className="event-item">
              <EventRenderer event={event} observations={obs} />
            </div>
          );
        })}
      </div>

      {isGeneratingReport && <GeneratingHint />}

      {isDone && finalReport && <FinalReport report={finalReport} />}
    </div>
  );
}
