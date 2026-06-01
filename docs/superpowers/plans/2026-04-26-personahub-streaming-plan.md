# Personahub 全链路流式渲染实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Personahub 的 AI thinking、工具调用结果、最终报告全部改为 Token 级别流式返回，实现实时打字机效果。

**Architecture:** 后端 minimax-client 新增 `chatStream()` 异步生成器，解析 MiniMax SSE 流式响应，agent-loop 消费并 emit 流式 SSE 事件给前端，前端 useAnalysis 累加状态并通过智能滚动渲染。

**Tech Stack:** MiniMax API (stream: true), Server-Sent Events (SSE), React 18, react-markdown, remark-gfm, TypeScript

---

## 文件结构概览

| 文件                                  | 职责                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| `src/shared/types.ts`                 | 新增流式事件类型定义                                     |
| `src/server/agent/minimax-client.ts`  | 新增 `chatStream()` 流式生成器方法                       |
| `src/server/agent/agent-loop.ts`      | 改造为流式消费模式，emit 流式事件                        |
| `src/app/hooks/useAnalysis.ts`        | 新增流式事件监听，状态累加；移除旧的 final_report 监听器 |
| `src/app/hooks/useScroll.ts`          | 智能滚动状态管理                                         |
| `src/app/components/AgentStream.tsx`  | 整合所有流式组件和滚动逻辑                               |
| `src/app/components/ThinkingCard.tsx` | AI 思考内容卡片组件（新增）                              |
| `src/app/components/ToolCard.tsx`     | 复用现有组件，无需新增 ToolResult                        |

**注意**：现有 `ToolCard.tsx` 组件已可复用，将工具结果渲染逻辑集成到 `AgentStream.tsx` 中。

---

## Task 1: 更新类型定义

**Files:**

- Modify: `src/shared/types.ts`

- [ ] **Step 1: 添加新的 SSE 事件类型**

```typescript
export type SSEEventType =
  | "step"
  | "tool_start"
  | "thinking_chunk" // 新增：AI 思考内容片段
  | "thinking_done" // 新增：AI 思考完成
  | "tool_result_done" // 新增：工具结果完成（工具执行本身非流式，结果一次性 emit）
  | "report_chunk" // 新增：报告内容片段
  | "report_done" // 新增：报告生成完成
  | "report_error" // 新增：报告生成错误
  | "observation"
  | "error"
  | "done";
```

**注意**：`tool_result_chunk` 本次不启用（工具执行本身非流式），保留类型扩展性。

- [ ] **Step 2: 添加 AgentEvent 接口扩展**

在现有 `AgentEvent` 接口中添加新字段：

```typescript
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
  // 新增：流式专用
  thinkingContent?: string; // thinking_chunk 专用
  isStreaming?: boolean; // 是否处于流式过程中
}
```

- [ ] **Step 3: 提交**

```bash
cd /home/yujiangan/personahub
git add src/shared/types.ts
git commit -m "feat: add streaming SSE event types"
```

---

## Task 2: MiniMaxClient 新增 chatStream 流式方法

**Files:**

- Modify: `src/server/agent/minimax-client.ts`

- [ ] **Step 1: 添加流式相关类型定义**

```typescript
// 流式片段类型（discriminated union）
export type StreamChunk =
  | { type: "reasoning"; reasoning: string; done: false }
  | { type: "content"; content: string; done: false }
  | { type: "tool_call"; toolCall: { id: string; name: string; arguments: string }; done: false }
  | { type: "done"; done: true };

// MiniMax SSE 原始数据结构
interface MiniMaxDelta {
  content?: string;
  reasoning_details?: Array<{
    type: string;
    id?: string;
    index?: number;
    text?: string;
  }>;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    index?: number;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}
```

- [ ] **Step 2: 实现 chatStream 异步生成器方法**

```typescript
async *chatStream(
  messages: MiniMaxMessage[],
  tools?: object[]
): AsyncGenerator<StreamChunk> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  const response = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    },
    body: JSON.stringify({
      model: this.model,
      messages,
      tools,
      stream: true,
      max_tokens: this.maxTokens,
      extra_body: { reasoning_split: true },
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MiniMax API error: ${response.status} - ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoningBuffer = "";
  let contentBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { type: "done", done: true };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta as MiniMaxDelta | undefined;

          // 处理 reasoning_details（增量累积）
          if (delta?.reasoning_details?.length) {
            const reasoningText = delta.reasoning_details[0].text || "";
            if (reasoningText.length > reasoningBuffer.length) {
              const newReasoning = reasoningText.slice(reasoningBuffer.length);
              reasoningBuffer = reasoningText;
              if (newReasoning) {
                yield { type: "reasoning", reasoning: newReasoning, done: false };
              }
            }
          }

          // 处理 content（增量累积）
          if (delta?.content) {
            const contentText = delta.content;
            if (contentText.length > contentBuffer.length) {
              const newContent = contentText.slice(contentBuffer.length);
              contentBuffer = contentText;
              if (newContent) {
                yield { type: "content", content: newContent, done: false };
              }
            }
          }

          // 处理 tool_calls（流式返回 id + name，然后 arguments 片段）
          if (delta?.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              if (tc.id && tc.function?.name) {
                // 新的工具调用开始
                const toolCall: ToolCall = {
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || "",
                  },
                };
                yield { type: "tool_call", toolCall, done: false };
              } else if (tc.function?.arguments) {
                // 追加 arguments 片段
                // 注意：这里需要累积完整的 arguments
                pendingToolCalls.get(tc.id)?.function.arguments
              }
            }
          }

          // 检查是否结束
          if (choice.finish_reason === "stop") {
            yield { type: "done", done: true };
            return;
          }
        } catch (e) {
          // 忽略解析错误，继续处理下一行
          console.warn("Failed to parse SSE data:", e);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 3: 保留原有 chat 方法（用于非流式场景）**

原有 `chat()` 方法保持不变，用于快速检查等不需要流式的场景。

- [ ] **Step 4: 提交**

```bash
git add src/server/agent/minimax-client.ts
git commit -m "feat: add chatStream async generator for streaming responses"
```

---

## Task 3: agent-loop.ts 全链路流式改造

**Files:**

- Modify: `src/server/agent/agent-loop.ts`

- [ ] **Step 1: 分析现有主循环结构**

现有主循环在 `runAgentLoop` 函数中，流程是：

1. 调用 `minimaxClient.chat()` 获取完整响应
2. 根据 `finish_reason` 判断是 tool_calls 还是结束
3. 如果是 tool_calls，执行工具并循环
4. 如果是结束，调用 `minimaxClient.chat()` 生成报告

**改造后流程**：

1. 调用 `minimaxClient.chatStream()` 流式消费
2. 根据 chunk 类型分别处理 reasoning / content / tool_call
3. reasoning → emit thinking_chunk
4. content → 判断是中间结果还是最终报告
5. tool_call → 收集完整后执行工具
6. 报告 → emit report_chunk

- [ ] **Step 2: 改造主循环为流式消费模式**

替换现有 `while` 循环中的 MiniMax 调用部分：

```typescript
// 旧代码
const response = await minimaxClient.chat(messages, allTools);
const { content, toolCalls, finishReason } = response;

if (finishReason !== "tool_calls") {
  // 发送 thinking 事件触发 "正在生成分析" 提示
  await emitter.emit("thinking", `正在生成洞察...`);
  const dataSummary = constructDataSummary(agentCtx);
  const analysisMessages = [...];
  const analysisResponse = await minimaxClient.chat(analysisMessages, []);
  await emitter.emit("final_report", analysisResponse.content || "");
  return;
}

// 新代码
let pendingToolCalls: Map<string, ToolCall> = new Map();

for await (const chunk of minimaxClient.chatStream(messages, allTools)) {
  if (chunk.done) break;

  switch (chunk.type) {
    case "reasoning":
      await emitter.emit("thinking_chunk", chunk.reasoning);
      break;
    case "content":
      await emitter.emit("report_chunk", chunk.content);
      break;
    case "tool_call":
      pendingToolCalls.set(chunk.toolCall.id, chunk.toolCall);
      break;
  }
}

// 所有流式消费完成后，检查是否有工具调用
// 如果有，执行工具并继续循环
// 如果没有，说明是最终报告
```

- [ ] **Step 3: 改造报告生成为流式**

```typescript
// 旧代码
const analysisResponse = await minimaxClient.chat(analysisMessages, []);
const analysisContent = analysisResponse.content || "无法生成分析报告";
await emitter.emit("final_report", analysisContent);

// 新代码
await emitter.emit("thinking_done", "");

let reportContent = "";
for await (const chunk of minimaxClient.chatStream(analysisMessages, [])) {
  if (chunk.done) break;
  if (chunk.type === "content") {
    reportContent += chunk.content;
    await emitter.emit("report_chunk", chunk.content);
  }
}
await emitter.emit("report_done", "");
```

- [ ] **Step 4: 处理错误和完成**

```typescript
// 在流式消费循环外添加错误处理
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : "未知错误";
  await emitter.emit("thinking_done", "");
  await emitter.emit("report_error", `流式传输错误: ${errorMsg}`);
  await emitter.emit("done", "");
}
```

- [ ] **Step 5: 提交**

```bash
git add src/server/agent/agent-loop.ts
git commit -m "feat: refactor agent-loop to use streaming chatStream"
```

---

## Task 4: useAnalysis.ts 新增流式事件监听

**Files:**

- Modify: `src/app/hooks/useAnalysis.ts`

- [ ] **Step 1: 更新 State 类型定义**

```typescript
interface AnalysisState {
  events: AgentEvent[];
  finalReport: string;
  thinkingContent: string; // 新增：思考内容累加
  toolResults: Record<string, string>; // 新增：各工具结果累加
  isGeneratingReport: boolean;
  isDone: boolean;
  error: string | null;
  observationsByTool: Record<string, AgentEvent[]>;
}
```

- [ ] **Step 2: 新增流式事件监听器**

在现有 `eventSource.addEventListener` 部分添加：

```typescript
// 思考内容流式监听
eventSource.addEventListener("thinking_chunk", (e) => {
  const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
  if (!wrapper) return;
  setState((prev) => ({
    ...prev,
    thinkingContent: prev.thinkingContent + wrapper.content,
  }));
});

// thinking 完成
eventSource.addEventListener("thinking_done", () => {
  // thinking 完成，可以结束 thinking 显示或转场
  // 目前只需要更新状态即可
});

// 报告内容流式监听
eventSource.addEventListener("report_chunk", (e) => {
  const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
  if (!wrapper) return;
  setState((prev) => ({
    ...prev,
    finalReport: prev.finalReport + wrapper.content,
    isGeneratingReport: true,
  }));
});

// 报告完成
eventSource.addEventListener("report_done", () => {
  hasReceivedFinalReportRef.current = true;
  setState((prev) => ({
    ...prev,
    isGeneratingReport: false,
    isDone: true,
  }));
});

// 报告错误
eventSource.addEventListener("report_error", (e) => {
  const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
  if (!wrapper) return;
  setState((prev) => ({
    ...prev,
    error: wrapper.content,
    isGeneratingReport: false,
  }));
});
```

- [ ] **Step 3: 更新 resetState 函数**

```typescript
const resetState = useCallback(() => {
  eventCounterRef.current = 0;
  pendingToolsRef.current.clear();
  currentToolCallIdRef.current = null;
  hasReceivedFinalReportRef.current = false;
  setState({
    ...initialState,
    thinkingContent: "",
    toolResults: {},
    observationsByTool: {},
  });
}, []);
```

- [ ] **Step 4: 移除旧的 final_report 监听器并添加新监听器**

在现有文件中，找到并**删除**这段代码：

```typescript
eventSource.addEventListener("final_report", (e) => {
  const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
  if (!wrapper) return;
  hasReceivedFinalReportRef.current = true;
  setState((prev) => ({ ...prev, finalReport: wrapper.content, isGeneratingReport: false }));
});
```

然后在同位置**添加**新的流式监听器（见 Step 2）。

- [ ] **Step 5: 提交**

```bash
git add src/app/hooks/useAnalysis.ts
git commit -m "feat: add streaming event listeners to useAnalysis"
```

---

## Task 5: 创建 useScroll.ts 智能滚动 Hook

**Files:**

- Create: `src/app/hooks/useScroll.ts`

- [ ] **Step 1: 创建 useScroll hook**

```typescript
import { useState, useRef, useCallback, useEffect } from "react";

const SCROLL_THRESHOLD = 100; // 像素

interface UseScrollOptions {
  threshold?: number;
}

export function useScroll(options: UseScrollOptions = {}) {
  const threshold = options.threshold ?? SCROLL_THRESHOLD;
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  // 判断用户是否在页面底部
  const isNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, [threshold]);

  // 滚动到容器底部
  const scrollToBottom = useCallback(() => {
    if (!autoScrollEnabled) return;

    const container = containerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [autoScrollEnabled]);

  // 处理用户滚动事件
  const handleScroll = useCallback(() => {
    if (isNearBottom()) {
      setAutoScrollEnabled(true);
    } else {
      setAutoScrollEnabled(false);
    }
  }, [isNearBottom]);

  return {
    containerRef,
    autoScrollEnabled,
    setAutoScrollEnabled,
    handleScroll,
    scrollToBottom,
    isNearBottom,
  };
}
```

- [ ] **Step 2: 提交**

```bash
git add src/app/hooks/useScroll.ts
git commit -m "feat: add useScroll hook for smart auto-scroll"
```

---

## Task 6: AgentStream.tsx 整合流式组件和滚动

**Files:**

- Modify: `src/app/components/AgentStream.tsx`

- [ ] **Step 1: 添加 useScroll hook 集成**

```typescript
import { useScroll } from "../hooks/useScroll";

// 在组件内使用
const { containerRef, autoScrollEnabled, handleScroll, scrollToBottom } = useScroll();

// 监听内容变化，自动滚动
useEffect(() => {
  scrollToBottom();
}, [thinkingContent, finalReport, scrollToBottom]);
```

- [ ] **Step 2: 更新 props 接口**

```typescript
interface AgentStreamProps {
  finalReport: string;
  isDone: boolean;
  error: string | null;
  isGeneratingReport: boolean;
  events: AgentEvent[];
  observationsByTool?: Record<string, AgentEvent[]>;
  thinkingContent?: string; // 新增
  toolResults?: Record<string, string>; // 新增
}
```

- [ ] **Step 3: 添加滚动容器**

```typescript
return (
  <div className="agent-stream">
    {error && <div className="error-block">❌ {error}</div>}

    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="agent-stream-container"
    >
      {/* 思考内容 */}
      {thinkingContent && (
        <div className="thinking-card">
          <div className="thinking-label">🤔 AI 思考中...</div>
          <div className="thinking-content">{thinkingContent}</div>
        </div>
      )}

      {/* 工具结果 */}
      {toolResults && Object.entries(toolResults).map(([toolId, content]) => (
        <div key={toolId} className="tool-result" id={`tool-${toolId}`}>
          {content}
        </div>
      ))}

      {/* 报告内容 */}
      {finalReport && (
        <div className="final-report-container">
          {/* ... 现有报告渲染逻辑 ... */}
        </div>
      )}
    </div>

    {/* 新内容提示（当停止自动滚动时显示） */}
    {!autoScrollEnabled && !isDone && (
      <button
        className="scroll-to-bottom-hint"
        onClick={() => {
          setAutoScrollEnabled(true);
          scrollToBottom();
        }}
      >
        ↓ 新内容
      </button>
    )}

    {isGeneratingReport && <GeneratingHint />}
  </div>
);
```

- [ ] **Step 4: 添加样式**

在 `agent-stream.css` 中添加：

```css
.agent-stream-container {
  max-height: 70vh;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.scroll-to-bottom-hint {
  position: fixed;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  background: #3b82f6;
  color: white;
  padding: 8px 16px;
  border-radius: 20px;
  border: none;
  cursor: pointer;
  font-size: 14px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
}

.scroll-to-bottom-hint:hover {
  background: #2563eb;
}
```

- [ ] **Step 5: 提交**

```bash
git add src/app/components/AgentStream.tsx src/app/components/agent-stream.css
git commit -m "feat: integrate streaming components and smart scroll"
```

---

## Task 7: 视觉验证和测试

**说明**：本任务为手动视觉验证。自动化单元测试作为后续优化项。

**Files:** (无文件变更，仅测试验证)

- [ ] **Step 1: 启动开发服务器**

```bash
cd /home/yujiangan/personahub
pnpm dev
```

- [ ] **Step 2: 打开浏览器测试**

1. 打开 http://localhost:5173
2. 输入一个 GitHub 用户名
3. 观察 Network -> EventStream 连接
4. 验证 SSE 事件按类型分布

- [ ] **Step 3: 验证智能滚动**

1. 观察 thinking 内容实时出现
2. 观察报告内容逐步出现
3. 手动往上滚动，确认停止自动滚动
4. 点击"↓ 新内容"按钮，确认跳转到底部
5. 滚回到底部，确认恢复自动滚动

- [ ] **Step 4: 验证表格渲染**

1. 等待报告生成完成
2. 确认 GFM 表格正确渲染
3. 确认复制按钮功能正常

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "test: verify streaming functionality"
```

---

## 执行选项

**Plan complete and saved to `docs/superpowers/plans/2026-04-26-personahub-streaming-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
