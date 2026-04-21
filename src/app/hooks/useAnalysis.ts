import { useState, useEffect, useRef, useCallback } from "react";

export type SSEEventType =
  | "thinking"
  | "tool_start"
  | "tool_end"
  | "observation"
  | "step"
  | "final_report"
  | "error"
  | "done";

export interface AgentEvent {
  id: string;
  type: SSEEventType;
  timestamp: number;
  // thinking
  content?: string;
  // tool_start
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  // tool_end
  toolSuccess?: boolean;
  toolResult?: unknown;
  toolSummary?: string;
  toolError?: string | null;
}

interface AnalysisState {
  events: AgentEvent[];
  finalReport: string;
  isGeneratingReport: boolean;
  isDone: boolean;
  error: string | null;
  // Observations indexed by toolCallId for easy lookup
  observationsByTool: Record<string, AgentEvent[]>;
}

interface SSEWrapper {
  type: string;
  content: string;
  timestamp: number;
}

const initialState: AnalysisState = {
  events: [],
  finalReport: "",
  isGeneratingReport: false,
  isDone: false,
  error: null,
  observationsByTool: {},
};

function safeParseJSON<T>(data: string, fallback: T): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

export function useAnalysis(githubId: string | null) {
  const [state, setState] = useState<AnalysisState>(initialState);
  const eventSourceRef = useRef<EventSource | null>(null);
  const isConnectingRef = useRef(false);
  const eventCounterRef = useRef(0);
  // Track pending tool_start events keyed by toolCallId for merging with tool_end
  const pendingToolsRef = useRef<Map<string, AgentEvent>>(new Map());
  // Track current active toolCallId for associating observations
  const currentToolCallIdRef = useRef<string | null>(null);
  // Track if we've received final_report to prevent thinking events from re-enabling generating state
  const hasReceivedFinalReportRef = useRef(false);

  const generateEventId = useCallback(() => {
    eventCounterRef.current += 1;
    return `event-${Date.now()}-${eventCounterRef.current}`;
  }, []);

  const resetState = useCallback(() => {
    eventCounterRef.current = 0;
    pendingToolsRef.current.clear();
    currentToolCallIdRef.current = null;
    hasReceivedFinalReportRef.current = false;
    setState({ ...initialState, observationsByTool: {} });
  }, []);

  const connect = useCallback(
    (id: string) => {
      if (isConnectingRef.current) return;
      isConnectingRef.current = true;

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      resetState();

      const eventSource = new EventSource(`/api/analyze?githubId=${encodeURIComponent(id)}`);
      eventSourceRef.current = eventSource;

      eventSource.addEventListener("thinking", (e) => {
        const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
        if (!wrapper) return;
        const content = wrapper.content as string;
        const isGenerating = content.includes("正在生成洞察") || content.includes("正在生成分析");
        // 如果是生成报告的提示，只触发 isGeneratingReport，不显示 thinking 卡片
        if (isGenerating) {
          if (!hasReceivedFinalReportRef.current) {
            setState((prev) => ({ ...prev, isGeneratingReport: true }));
          }
          return;
        }
        const event: AgentEvent = {
          id: generateEventId(),
          type: "thinking",
          timestamp: wrapper.timestamp,
          content,
        };
        // Only update isGeneratingReport if we haven't received final_report yet
        if (!hasReceivedFinalReportRef.current) {
          setState((prev) => ({
            ...prev,
            events: [...prev.events, event],
            isGeneratingReport: isGenerating || prev.isGeneratingReport,
          }));
        } else {
          setState((prev) => ({ ...prev, events: [...prev.events, event] }));
        }
      });

      eventSource.addEventListener("tool_start", (e) => {
        const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
        if (!wrapper) return;
        const toolData = safeParseJSON<Record<string, unknown>>(wrapper.content, {});
        const toolCallId = toolData.toolCallId as string | undefined;
        const event: AgentEvent = {
          id: generateEventId(),
          type: "tool_start",
          timestamp: wrapper.timestamp,
          toolCallId,
          toolName: toolData.toolName as string | undefined,
          toolInput: toolData.input as Record<string, unknown> | undefined,
        };
        // Store in pending map and update current tool
        if (toolCallId) {
          pendingToolsRef.current.set(toolCallId, event);
          currentToolCallIdRef.current = toolCallId;
        }
        setState((prev) => ({ ...prev, events: [...prev.events, event] }));
      });

      eventSource.addEventListener("tool_end", (e) => {
        const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
        if (!wrapper) return;
        const toolData = safeParseJSON<Record<string, unknown>>(wrapper.content, {});
        const toolCallId = toolData.toolCallId as string | undefined;
        setState((prev) => {
          // Remove tool_start event if it exists
          const newEvents = toolCallId
            ? prev.events.filter(
                (ev) => !(ev.type === "tool_start" && ev.toolCallId === toolCallId),
              )
            : prev.events;
          // Remove from pending map
          if (toolCallId) {
            pendingToolsRef.current.delete(toolCallId);
          }
          const event: AgentEvent = {
            id: generateEventId(),
            type: "tool_end",
            timestamp: wrapper.timestamp,
            toolCallId,
            toolName: toolData.toolName as string | undefined,
            toolSuccess: toolData.toolSuccess as boolean | undefined,
            toolResult: toolData.toolResult as unknown,
            toolSummary: toolData.toolSummary as string | undefined,
            toolError: toolData.toolError as string | null | undefined,
          };
          return {
            ...prev,
            events: [...newEvents, event],
          };
        });
      });

      eventSource.addEventListener("observation", (e) => {
        const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
        if (!wrapper) return;
        // Parse the content to extract toolCallId and content
        const obsData = safeParseJSON<{ content: string; toolCallId?: string }>(wrapper.content, {
          content: wrapper.content as string,
        });
        const event: AgentEvent = {
          id: generateEventId(),
          type: "observation",
          timestamp: wrapper.timestamp,
          content: obsData.content,
          toolCallId: obsData.toolCallId || currentToolCallIdRef.current || undefined,
        };
        const toolId = event.toolCallId;
        setState((prev) => {
          const newObservationsByTool = { ...prev.observationsByTool };
          if (toolId) {
            newObservationsByTool[toolId] = [...(newObservationsByTool[toolId] || []), event];
          }
          return {
            ...prev,
            events: [...prev.events, event],
            observationsByTool: newObservationsByTool,
          };
        });
      });

      eventSource.addEventListener("step", (e) => {
        const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
        if (!wrapper) return;
        const event: AgentEvent = {
          id: generateEventId(),
          type: "step",
          timestamp: wrapper.timestamp,
          content: wrapper.content as string,
        };
        setState((prev) => ({ ...prev, events: [...prev.events, event] }));
      });

      eventSource.addEventListener("final_report", (e) => {
        const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
        if (!wrapper) return;
        hasReceivedFinalReportRef.current = true;
        setState((prev) => ({ ...prev, finalReport: wrapper.content, isGeneratingReport: false }));
      });

      eventSource.addEventListener("error", (e: MessageEvent) => {
        if (!e.data) return;
        const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
        if (wrapper) {
          setState((prev) => ({ ...prev, error: wrapper.content }));
        }
      });

      eventSource.addEventListener("done", () => {
        setState((prev) => ({ ...prev, isDone: true }));
        isConnectingRef.current = false;
      });
    },
    [resetState],
  );

  useEffect(() => {
    if (!githubId) return;
    isConnectingRef.current = false;
    const timer = setTimeout(() => connect(githubId), 100);
    return () => {
      clearTimeout(timer);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      isConnectingRef.current = false;
    };
  }, [githubId, connect]);

  return state;
}
