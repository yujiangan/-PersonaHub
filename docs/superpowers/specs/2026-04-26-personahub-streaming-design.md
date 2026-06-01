# Personahub 流式渲染改造设计文档

## 概述

**项目名称**: Personahub GitHub 分析工具流式渲染改造
**文档日期**: 2026-04-26
**目标**: 将 `final_report` 的完整返回改为 Token 级别的流式返回，实现报告的逐字渲染体验。

---

## 1. 背景与动机

当前实现中，AI 的思考内容、工具调用结果、最终报告都是**一次性完整返回**，用户需要等待所有 AI 推理完成后才能看到结果。

**问题**:

- 整个流程用户都无法看到实时进度
- AI thinking 内容是等完全部生成后才展示
- 工具调用结果也是一次性展示
- 长报告场景下用户等待时间不可控

**目标**:

- **全链路 Token 流式返回**：thinking、tool_result、final_report 全部边生成边展示
- 实现真正的"实时"打字机效果
- 保持 remarkGfm 表格和样式正确渲染

---

## 2. 技术约束

### 2.1 MiniMax API 流式格式

MiniMax `chatcompletion_v2` 接口支持 `stream: true` 参数，返回 **标准 OpenAI SSE 格式**：

```python
# 官方示例代码显示的流式结构
for chunk in stream:
    # reasoning_details 流式（增量累积）
    if chunk.choices[0].delta.reasoning_details:
        reasoning_text = chunk.choices[0].delta.reasoning_details[0]["text"]
        new_reasoning = reasoning_text[len(reasoning_buffer):]  # 取新增部分

    # content 流式（增量累积）
    if chunk.choices[0].delta.content:
        content_text = chunk.choices[0].delta.content
        new_text = content_text[len(text_buffer):]  # 取新增部分
```

**确认信息**：

- SSE event 类型: **标准 `message`**（不是 `mesage`）
- 字段路径: `choices[0].delta.content` / `choices[0].delta.reasoning_details`
- reasoning_details: **✅ 流式返回**，但返回的是增量累积文本
- content: **✅ 流式返回**，也是增量累积文本
- tool_calls: 示例中未涉及，但结构应为 `choices[0].delta.tool_calls`

### 2.2 现有架构

```
┌─────────────┐    SSE     ┌──────────────┐    EventSource    ┌────────────────┐
│ MiniMax API │ ────────▶ │  agent-loop  │ ────────────────▶ │  useAnalysis   │
└─────────────┘            └──────────────┘                   └───────┬────────┘
                                                                      │
                                                                      ▼
                                                              ┌────────────────┐
                                                              │  AgentStream   │
                                                              │ (ReactMarkdown)│
                                                              └────────────────┘
```

### 2.3 react-markdown + remarkGfm 约束

- GFM 表格需要完整的 `| col |` 结构才能正确解析
- Token 流式返回时，不完整的 Markdown 可能导致解析错误或空渲染
- **解决方案**: 增量追加模式，已渲染的 DOM 保持不动，新 token 追加到容器末尾

---

## 3. 设计决策

| 决策项       | 选择                    | 理由                             |
| ------------ | ----------------------- | -------------------------------- |
| 流式粒度     | Token 级                | 最流畅用户体验                   |
| 前端渲染策略 | 增量追加                | 保持已渲染内容稳定，避免整体重绘 |
| 错误处理     | 显示已有内容 + 错误提示 | 允许用户复制已生成的部分         |
| 兼容性       | 全面替换 `final_report` | 不维护死代码                     |

---

## 4. 架构改动

### 4.1 核心变化：全链路流式

当前流程（非流式）：

```
用户输入 → 等待 MiniMax 完整响应 → emit 所有 SSE 事件 → 前端渲染
```

新流程（全链路流式）：

```
用户输入 → MiniMax 流式响应（逐 token）→ 实时 emit SSE 事件 → 前端实时渲染
```

**关键区别**：

- MiniMax API 调用全部改为 `stream: true`
- reasoning（思考过程）边生成边发送
- 工具调用结果边生成边发送
- 报告内容边生成边发送

### 4.2 事件类型变更

**废弃**:

- `thinking` - 一次性返回完整思考内容
- `tool_end` - 一次性返回完整工具结果
- `final_report` - 一次性返回完整报告

**新增（流式事件）**:

- `thinking_chunk` - AI 思考内容的增量片段
- `thinking_done` - AI 思考完成
- `tool_result_chunk` - 工具结果的增量片段
- `tool_result_done` - 工具结果完成
- `report_chunk` - 报告内容的增量片段
- `report_done` - 报告生成完成
- `report_error` - 报告生成出错

```typescript
// src/shared/types.ts
export type SSEEventType =
  | "step"
  | "tool_start"
  | "thinking_chunk" // 新增：AI 思考内容片段
  | "thinking_done" // 新增：AI 思考完成
  | "tool_result_chunk" // 新增：工具结果片段
  | "tool_result_done" // 新增：工具结果完成
  | "report_chunk" // 新增：报告内容片段
  | "report_done" // 新增：报告生成完成
  | "report_error" // 新增：报告生成错误
  | "observation"
  | "error"
  | "done";
```

### 4.2 后端改动

#### 4.2.1 MiniMaxClient 全面流式化

**文件**: `src/server/agent/minimax-client.ts`

MiniMax 流式响应格式包含多个 SSE event 类型：

```
event: mesage
data: {"id":"xxx","choices":[{"index":0,"delta":{"content":"某"},"finish_reason":null}]}

event: mesage
data: {"id":"xxx","choices":[{"index":0,"delta":{"content":"个"},"finish_reason":null}]}

event: mesage
data: {"id":"xxx","choices":[{"index":0,"reasoning_details":[{"type":"text","id":"reasoning_xxx","index":0,"text":"思考内容片段"}],"finish_reason":null}]}
```

**新增流式接口**：

```typescript
// 流式片段类型
export interface StreamChunk {
  reasoning?: string;   // reasoning_details 新增文本
  content?: string;     // content 新增文本
  done: boolean;
}

// 核心流式方法
async *chatStream(
  messages: MiniMaxMessage[],
  tools?: object[]
): AsyncGenerator<StreamChunk> {
  // 1. 发起 stream: true 请求
  // 2. 逐块读取 response.body
  // 3. 解析 SSE JSON lines，提取:
  //    - choices[0].delta.reasoning_details[0].text (增量)
  //    - choices[0].delta.content (增量)
  //    - choices[0].delta.tool_calls (如需要)
  // 4. 计算增量文本（当前值 - buffer）
  // 5. yield 增量片段
  // 6. choices[0].finish_reason === "stop" 时 yield done: true
}
```

**关键点**：

- SSE event 类型是标准 `message`（不是 `mesage`）
- reasoning 和 content 都是**增量累积**返回，需计算差值
- tool_calls 逐步返回 `id` + `function.name` → `function.arguments` JSON 片段

#### 4.2.2 agent-loop.ts 全链路流式改造

**文件**: `src/server/agent/agent-loop.ts`

改造点：

1. **thinking 流式化**：

```typescript
// 旧代码
if (response.reasoning?.length) {
  await emitter.emit("thinking", `LLM 思考: ${response.reasoning.join(" ")}`);
}

// 新代码
for await (const chunk of minimaxClient.chatStream(messages, allTools)) {
  if (chunk.done) break;

  if (chunk.type === "reasoning") {
    await emitter.emit("thinking_chunk", chunk.reasoning || "");
  }

  if (chunk.type === "tool_call") {
    // 收集 tool_call 片段，组装完整工具调用
  }

  if (chunk.type === "content") {
    // 最终内容
  }
}
```

2. **工具调用结果流式化**：

```typescript
// 旧代码
const toolResults = await Promise.all(
  toolCalls.map(async (toolCall) => {
    // ...执行工具...
    await emitter.emit("tool_end", JSON.stringify({...}));
    return {...};
  })
);

// 新代码
// 工具执行本身可能很快，但结果展示也可以流式
for (const tr of toolResults) {
  await emitter.emit("tool_result_done", JSON.stringify({
    toolCallId: tr.id,
    toolName: tr.name,
    toolSuccess: tr.success,
    summary: tr.summary,
  }));
}
```

3. **报告流式化**：

```typescript
// 旧代码
const analysisResponse = await minimaxClient.chat(analysisMessages, []);
const analysisContent = analysisResponse.content || "无法生成分析报告";
await emitter.emit("final_report", analysisContent);

// 新代码
for await (const chunk of minimaxClient.chatStream(analysisMessages, [])) {
  if (chunk.done) break;
  if (chunk.type === "content") {
    await emitter.emit("report_chunk", chunk.content || "");
  }
}
await emitter.emit("report_done", "");
```

#### 4.2.3 SSE 事件格式（全面流式）

MiniMax API 端直接返回 SSE，agent-loop 解析后转发为前端 SSE 事件：

```
event: message
data: {"id":"xxx","choices":[{"delta":{"reasoning_details":[{"text":"LLM 正在思考..."}]}}]}

event: message
data: {"id":"xxx","choices":[{"delta":{"reasoning_details":[{"text":"从仓库列表来看..."}]}}]}

event: message
data: {"id":"xxx","choices":[{"delta":{"content":"某"}}]}

event: message
data: {"id":"xxx","choices":[{"delta":{"content":"个"}}]}

event: message
data: {"id":"xxx","choices":[{"delta":{"tool_calls":[{"id":"call_xxx","function":{"name":"get_user_repos","arguments":"{}"}}]}}]}

event: message
data: {"id":"xxx","choices":[{"finish_reason":"stop"}]}
```

前端 SSE 事件：

```
event: thinking_chunk
data: {"type":"thinking_chunk","content":"LLM 正在思考如何分析...","timestamp":1234567890}

event: thinking_chunk
data: {"type":"thinking_chunk","content":"从仓库列表来看，该用户主要使用 TypeScript...","timestamp":1234567891}

event: thinking_done
data: {"type":"thinking_done","content":"","timestamp":1234567892}

event: tool_start
data: {"type":"tool_start","content":"{\"toolCallId\":\"xxx\",\"toolName\":\"get_user_repos\",...}","timestamp":1234567893}

event: tool_result_done
data: {"type":"tool_result_done","content":"{\"name\":\"repo1\",\"language\":\"TypeScript\"}","timestamp":1234567894}

event: report_chunk
data: {"type":"report_chunk","content":"某","timestamp":1234567897}

event: report_chunk
data: {"type":"report_chunk","content":"个","timestamp":1234567898}

event: report_done
data: {"type":"report_done","content":"","timestamp":1234567899}
```

**注意**：tool_result_chunk 是否需要取决于工具执行结果是否流式返回。从工具执行角度看结果是一次性生成的，可能不需要 chunk。

### 4.3 前端改动

#### 4.3.1 useAnalysis.ts 全链路流式改造

**文件**: `src/app/hooks/useAnalysis.ts`

**State 变更**：

```typescript
interface AnalysisState {
  events: AgentEvent[];
  finalReport: string; // 累加模式
  thinkingContent: string; // 新增：思考内容累加
  toolResults: Record<string, string>; // 新增：各工具结果累加
  isGeneratingReport: boolean;
  isDone: boolean;
  error: string | null;
  observationsByTool: Record<string, AgentEvent[]>;
}
```

**新增/修改的事件监听**：

```typescript
// 思考内容流式
eventSource.addEventListener("thinking_chunk", (e) => {
  const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
  if (!wrapper) return;
  setState((prev) => ({
    ...prev,
    thinkingContent: prev.thinkingContent + wrapper.content,
  }));
});

eventSource.addEventListener("thinking_done", () => {
  // thinking 完成，可以结束 thinking 显示或转场
});

// 工具结果流式
eventSource.addEventListener("tool_result_chunk", (e) => {
  const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
  if (!wrapper) return;
  const toolData = safeParseJSON<{ toolCallId?: string; content?: string }>(wrapper.content, {});
  const toolId = toolData.toolCallId || "";
  setState((prev) => ({
    ...prev,
    toolResults: {
      ...prev.toolResults,
      [toolId]: (prev.toolResults[toolId] || "") + (toolData.content || ""),
    },
  }));
});

eventSource.addEventListener("tool_result_done", (e) => {
  // 工具结果完成，可以显示完整结果
});

// 报告内容流式
eventSource.addEventListener("report_chunk", (e) => {
  const wrapper = safeParseJSON<SSEWrapper | null>(e.data, null);
  if (!wrapper) return;
  setState((prev) => ({
    ...prev,
    finalReport: prev.finalReport + wrapper.content,
    isGeneratingReport: true,
  }));
});

eventSource.addEventListener("report_done", () => {
  hasReceivedFinalReportRef.current = true;
  setState((prev) => ({
    ...prev,
    isGeneratingReport: false,
    isDone: true,
  }));
});

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

#### 4.3.2 AgentStream.tsx 渲染策略

**文件**: `src/app/components/AgentStream.tsx`

**增量追加渲染模式**：

```typescript
function ThinkingCard({ content }: { content: string }) {
  return (
    <div className="thinking-card">
      <div className="thinking-label">🤔 AI 思考中...</div>
      <div className="thinking-content">{content}</div>
    </div>
  );
}

function ToolResult({ toolId, content }: { toolId: string; content: string }) {
  // 工具结果增量渲染
  return (
    <div className="tool-result" id={`tool-${toolId}`}>
      <div className="tool-result-content">{content}</div>
    </div>
  );
}

function FinalReport({ report }: { report: string }) {
  // ... copy button logic ...

  return (
    <div className="final-report-container">
      <div className="reply-block">
        <div className="copy-button-wrapper">
          <button onClick={handleCopy} className={`copy-button ${copied ? "copied" : ""}`}>
            {copied ? "✓ 已复制" : "📋 复制报告"}
          </button>
        </div>
        <div className="markdown-body" key={report.length > 0 ? "stable" : "empty"}>
          <ReactMarkdown remarkPlugins={[remarkGfm as Pluggable]}>{report}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
```

**关键渲染逻辑**：

```typescript
export default function AgentStream({
  thinkingContent,
  toolResults,
  finalReport,
  // ...
}: AgentStreamProps) {
  return (
    <div className="agent-stream">
      {/* 思考内容实时显示 */}
      {thinkingContent && <ThinkingCard content={thinkingContent} />}

      {/* 工具结果实时显示 */}
      {Object.entries(toolResults).map(([toolId, content]) => (
        <ToolResult key={toolId} toolId={toolId} content={content} />
      ))}

      {/* 报告实时显示 */}
      {finalReport && <FinalReport report={finalReport} />}
    </div>
  );
}
```

#### 4.3.3 智能自动滚动（Smart Scroll）

**目标**：当报告变长时，新内容自动向下滚动；但如果用户主动往上翻看旧内容，则停止自动滚动，避免"抢夺"用户视线。

**核心状态**：

```typescript
interface ScrollState {
  autoScrollEnabled: boolean; // 是否启用自动滚动
  userScrollingUp: boolean; // 用户是否主动往上翻
}
```

**判断逻辑**：

```typescript
// 判断用户是否在页面底部的阈值
const SCROLL_THRESHOLD = 100; // 像素

function isNearBottom(container: HTMLElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = container;
  return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
}

// 滚动事件处理
function handleScroll(e: React.UIEvent<HTMLDivElement>) {
  const container = e.currentTarget;

  if (isNearBottom(container)) {
    // 用户滚到底部 → 恢复自动滚动
    setAutoScrollEnabled(true);
    setUserScrollingUp(false);
  } else {
    // 用户往上翻 → 停止自动滚动
    setAutoScrollEnabled(false);
    setUserScrollingUp(true);
  }
}

// 新内容到达时触发滚动
function scrollToBottom() {
  if (!autoScrollEnabled) return;

  const container = containerRef.current;
  if (container) {
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth", // 平滑滚动
    });
  }
}
```

**使用方式**：

```typescript
// 在组件中
const containerRef = useRef<HTMLDivElement>(null);
const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

// 监听内容变化，自动滚动
useEffect(() => {
  scrollToBottom();
}, [thinkingContent, toolResults, finalReport]);

// 容器上绑定
<div
  ref={containerRef}
  onScroll={handleScroll}
  className="agent-stream-container"
>
  {/* 内容 ... */}
</div>
```

**交互细节**：

| 用户行为     | autoScrollEnabled | 效果                       |
| ------------ | ----------------- | -------------------------- |
| 默认状态     | `true`            | 新内容自动平滑滚动到底部   |
| 手动往上滚动 | `false`           | 停止自动滚动，保留当前位置 |
| 再次滚到底部 | `true`            | 恢复自动滚动               |
| 内容生成完成 | `false`           | 保持最终位置，不再强制滚动 |

**可选增强**：

1. **滚动指示器**：当停止自动滚动时，显示一个"↓ 新内容"提示，点击可跳转到底部
2. **防抖处理**：内容快速更新时使用 requestAnimationFrame 防抖，避免频繁滚动

---

## 5. 全链路数据流

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MiniMax API (流式)                              │
│  event: mesage  data: {delta:{content:"某"}, reasoning_details:[{text:"思考"}]}│
│  event: mesage  data: {delta:{content:"个"}, reasoning_details:[{text:"片段"}]}│
│  event: mesage  data: {delta:{content:"..."}}                               │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ fetch stream: true
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           minimaxClient.chatStream                           │
│  解析 SSE，区分 content / reasoning_details / tool_calls                    │
│  yield { type: "reasoning", reasoning: "思考片段" }                          │
│  yield { type: "content", content: "内容片段" }                             │
│  yield { type: "tool_call", toolCall: {...} }                               │
│  yield { type: "done" }                                                     │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ for await (chunk)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             agent-loop.ts                                    │
│  chunk.type === "reasoning"  → emitter.emit("thinking_chunk", chunk.reasoning)│
│  chunk.type === "content"     → emitter.emit("report_chunk", chunk.content)   │
│  chunk.type === "tool_call"  → 收集并执行工具 → emit("tool_result_chunk")   │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ SSE EventSource
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          useAnalysis.ts (前端状态)                            │
│  thinkingContent += chunk.reasoning                                          │
│  finalReport += chunk.content                                                │
│  toolResults[toolId] += chunk.result                                         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ React State Update
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AgentStream.tsx (UI)                              │
│  <ThinkingCard content={thinkingContent} />  ← 实时更新                      │
│  <ToolResult toolId={id} content={result} />  ← 实时更新                    │
│  <FinalReport report={finalReport} />  ← 实时更新 ReactMarkdown             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**关键流程点**：

1. **MiniMax 流式响应**：reasoning_details 和 content 都通过 SSE 逐片段返回
2. **minimaxClient.chatStream**：解析 SSE，分类 yield
3. **agent-loop**：接收 chunks，emit 对应 SSE 事件
4. **useAnalysis**：监听各类 chunk 事件，累加到状态
5. **AgentStream**：实时渲染各类型内容

---

## 6. 全链路错误处理

### 6.1 流式传输错误处理

| 错误场景         | 后端行为                                            | 前端展示                               |
| ---------------- | --------------------------------------------------- | -------------------------------------- |
| MiniMax API 超时 | emit `thinking_done` + emit `report_error` + `done` | 已有 thinking 和报告保留，显示错误信息 |
| MiniMax API 5xx  | emit `thinking_done` + emit `report_error` + `done` | 已有内容保留，显示错误信息             |
| 流式解析异常     | emit `thinking_done` + emit `report_error` + `done` | 已有内容保留，显示错误信息             |
| 网络中断（前端） | EventSource 自动重连或显示已有内容                  | 保留已接收的部分 + 错误提示            |

### 6.2 断点续传（不纳入本次）

如需支持网络中断后继续，需要：

- 后端记录已发送的 token 位置
- 前端重连时传递 `last_position`
- 后端从断点继续发送

---

## 7. 测试策略

### 7.1 单元测试

| 测试项                  | 文件              | 验证点                                      |
| ----------------------- | ----------------- | ------------------------------------------- |
| `chatStream` SSE 解析   | minimax-client.ts | content/reasoning/tool_call 分类正确        |
| `chatStream` chunk 分割 | minimax-client.ts | 多个 token 正确分割                         |
| thinking 累加逻辑       | useAnalysis.ts    | 多次 thinking_chunk 后 thinkingContent 正确 |
| tool_result 累加逻辑    | useAnalysis.ts    | 多次 tool_result_chunk 后 toolResults 正确  |
| report 累加逻辑         | useAnalysis.ts    | 多次 report_chunk 后 finalReport 正确       |

### 7.2 集成测试

| 测试项             | 验证点                                 |
| ------------------ | -------------------------------------- |
| 完整 thinking 流式 | reasoning_details 逐片段到达，最终完整 |
| 完整工具调用流式   | 工具结果边执行边显示                   |
| 完整报告流式       | Token 逐个到达，最终报告完整           |
| 网络中断恢复       | 已有内容保留，错误提示显示             |
| 表格渲染正确性     | GFM 表格语法完整时渲染正确             |
| thinking 渲染      | 思考内容实时打字机效果                 |

### 7.3 视觉验证清单

- [ ] 打开浏览器开发者工具，Network -> EventStream 连接
- [ ] 确认 SSE 事件按类型分布：thinking_chunk / tool_result_chunk / report_chunk
- [ ] 确认 thinking 内容实时出现，打字机效果流畅
- [ ] 确认工具结果边执行边显示
- [ ] 确认报告逐步出现，打字机效果流畅
- [ ] 确认表格最终渲染正确
- [ ] 确认复制按钮功能正常
- [ ] **确认智能滚动**：新内容时自动下滚
- [ ] **确认智能滚动**：手动上滚后停止自动滚动
- [ ] **确认智能滚动**：再次滚到底部后恢复自动滚动

---

## 8. 文件变更清单

| 文件路径                              | 变更类型 | 变更描述                                                                                                                                |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                 | 修改     | 新增 `thinking_chunk`, `thinking_done`, `tool_result_chunk`, `tool_result_done`, `report_chunk`, `report_done`, `report_error` 事件类型 |
| `src/server/agent/minimax-client.ts`  | 重构     | 新增 `chatStream()` 异步生成器方法；保留 `chat()` 方法（用于非流式场景如快速检查）                                                      |
| `src/server/agent/agent-loop.ts`      | 重构     | 主循环改为 `for await...of` 流式消费；thinking/tool_result/report 全部流式 emit                                                         |
| `src/server/lib/sse.ts`               | 无变更   | 事件格式兼容                                                                                                                            |
| `src/app/hooks/useAnalysis.ts`        | 重构     | state 新增 `thinkingContent`, `toolResults`；新增流式事件监听器                                                                         |
| `src/app/components/AgentStream.tsx`  | 重构     | 新增 `ThinkingCard` 组件、`ToolResult` 组件；`FinalReport` 保持；主组件组合所有流式内容；**新增智能自动滚动逻辑**                       |
| `src/app/components/ThinkingCard.tsx` | 新增     | AI 思考内容卡片组件                                                                                                                     |
| `src/app/hooks/useScroll.ts`          | 新增     | 智能滚动状态 hook（`autoScrollEnabled`, `userScrollingUp`, `scrollToBottom`）                                                           |
| `src/app/components/ToolResult.tsx`   | 新增     | 工具结果展示组件（可选，复用现有 ToolCard）                                                                                             |

---

## 9. 风险与缓解

| 风险                                            | 等级                    | 缓解措施                                                                              |
| ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| MiniMax 流式 SSE 格式与 OpenAI 不完全一致       | ~~**高**~~ → **已确认** | SSE 格式已确认，字段路径已知                                                          |
| reasoning_details 流式返回方式和 content 不同步 | ~~**高**~~ → **已确认** | reasoning_details 也是增量累积流式                                                    |
| tool_calls 在流式响应中的返回方式               | ~~**中**~~ → **已确认** | 流式返回：`id` + `function.name` 先到，后续 chunk 返回 `function.arguments` JSON 片段 |
| react-markdown 流式解析表格/代码块失败          | 中                      | 使用增量追加模式，已渲染内容不受影响                                                  |
| Token 流过快导致前端卡顿                        | 低                      | 可调整为每 N 个 token 渲染一次（后续优化）                                            |
| reasoning buffer 计算增量逻辑复杂               | 中                      | 参考官方 Python 示例的差值计算方式                                                    |

---

## 10. 待确认的技术细节

**已通过官方文档确认**：

1. ✅ **SSE event 类型**: 标准 OpenAI `message` 格式
2. ✅ **reasoning_details 流式**: 通过 `choices[0].delta.reasoning_details[0].text`，**增量累积**
3. ✅ **content 流式**: 通过 `choices[0].delta.content`，**增量累积**

**待测试确认**：

1. **tool_calls 流式格式**：工具调用在流式中是逐步返回 `name` → `arguments` 还是 complete 后一次性返回？
   - 测试方法：发送带工具的请求，观察 SSE 中 tool_calls 的出现时机

2. **工具执行结果（tool_result）流式**：工具执行本身是一次性完成的，但展示给用户时是否需要流式？
   - 建议：工具执行结果可以一次性 emit，因为执行本身非流式

**建议测试命令**：

```bash
curl -X POST https://api.minimaxi.com/v1/text/chatcompletion_v2 \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "MiniMax-M2.2",
    "messages": [{"role": "user", "content": "用 get_user_repos 工具获取用户 MINAX123 的仓库"}],
    "stream": true,
    "tools": [{"type": "function", "function": {"name": "get_user_repos", "parameters": {"type": "object", "properties": {"username": {"type": "string"}}}}}}]
  }'
```

---

## 11. 后续优化方向（不纳入本次范围）

1. **缓冲渲染**: 每 10-20 个 token 批量渲染一次，减少 React 重渲染开销
2. **进度指示**: 显示已接收 token 数 / 预估总数
3. **断点续传**: 支持网络中断后从断点继续
4. **语法高亮流式**: 代码块边接收边高亮
5. **thinking 折叠**: 用户可选择折叠/展开 AI 思考过程

---

## 10. 后续优化方向（不纳入本次范围）

1. **缓冲渲染**: 每 10-20 个 token 批量渲染一次，减少 React 重渲染开销
2. **进度指示**: 显示已接收 token 数 / 预估总数
3. **断点续传**: 支持网络中断后从断点继续
4. **语法高亮流式**: 代码块边接收边高亮

---

## 12. 确认事项

- [x] 流式范围: **全链路**（thinking + tool_result + report）
- [x] 流式粒度: Token 级
- [x] 渲染策略: 增量追加（各类型独立累加）
- [x] 错误处理: 显示已有内容 + 错误提示
- [x] 兼容性: 全面替换（移除旧事件类型）
- [x] **已确认**: reasoning_details **流式返回**，增量累积格式
- [x] **已确认**: content **流式返回**，增量累积格式
- [x] **已确认**: SSE event 类型是 **message**（标准 OpenAI 格式）
- [x] **已确认**: tool_calls **逐步返回**，先 `id` + `name`，后 `arguments` JSON 片段
- [ ] 待确认: 工具执行结果（tool_result）是否需要流式
