import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ThinkingCard from "./ThinkingCard";
import ToolCard from "./ToolCard";
import ObservationLine from "./ObservationLine";
import { useScroll } from "../hooks/useScroll";
import type { AgentEvent } from "../hooks/useAnalysis";
import "./agent-stream.css";

interface AgentStreamProps {
  finalReport: string;
  isDone: boolean;
  error: string | null;
  isGeneratingReport: boolean;
  events: AgentEvent[];
  observationsByTool?: Record<string, AgentEvent[]>;
  thinkingContent?: string;
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

  return (
    <div className="final-report-container">
      <div className="reply-block">
        <div className="copy-button-wrapper">
          <button onClick={handleCopy} className={`copy-button ${copied ? "copied" : ""}`}>
            {copied ? "✓ 已复制" : "📋 复制报告"}
          </button>
        </div>
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
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
  isGeneratingReport: _isGeneratingReport,
  events,
  observationsByTool = {},
  thinkingContent,
}: AgentStreamProps) {
  const { scrollToBottom } = useScroll();

  // 新内容到达时自动滚动
  useEffect(() => {
    scrollToBottom();
  }, [finalReport, thinkingContent, events, scrollToBottom]);

  if (!finalReport && !error && events.length === 0 && !thinkingContent) return null;

  return (
    <div className="agent-stream">
      {error && <div className="error-block">❌ {error}</div>}

      <div className="agent-stream-container">
        <div className="events-container">
          {events.map((event) => {
            const obs = event.toolCallId ? observationsByTool[event.toolCallId] : undefined;
            return (
              <div key={event.id} className="event-item">
                <EventRenderer event={event} observations={obs} />
              </div>
            );
          })}
          {/* 当前轮次尚未结束的流式思考，排在已有事件之后（例如工具结果之后的新一轮思考） */}
          {thinkingContent ? (
            <div className="event-item">
              <ThinkingCard content={thinkingContent} />
            </div>
          ) : null}
        </div>

        {/* 报告流式输出，边来边显示 */}
        {finalReport && <FinalReport report={finalReport} />}
      </div>
    </div>
  );
}
