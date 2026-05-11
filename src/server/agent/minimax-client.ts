const OPENAI_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M2.7";
const DEFAULT_MAX_TOKENS = 16000;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  index?: number;
}

export interface ReasoningDetail {
  type: string;
  id: string;
  format: string;
  index: number;
  text: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls: ToolCall[];
  reasoning_details: ReasoningDetail[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type MiniMaxMessage =
  | AssistantMessage
  | ToolMessage
  | { role: "system" | "user"; content: string };

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  reasoning: string[];
  rawMessage: AssistantMessage;
}

// 流式片段类型 (discriminated union)
export type StreamChunk =
  | { type: "reasoning"; reasoning: string; done: false }
  | { type: "content"; content: string; done: false }
  | { type: "tool_call"; toolCall: ToolCall; done: false }
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

function getStreamTextChunk(current: string, previous: string): string {
  if (!current || current === previous) return "";
  if (current.startsWith(previous)) return current.slice(previous.length);
  return current;
}

export class MiniMaxClient {
  private baseUrl = OPENAI_BASE_URL;

  constructor(
    private apiKey: string,
    private model: string = DEFAULT_MODEL,
    private maxTokens: number = DEFAULT_MAX_TOKENS,
  ) {}

  async chat(messages: MiniMaxMessage[], tools?: object[]): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
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
          stream: false,
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

      const data = (await response.json()) as any;
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error(
          `MiniMax API 异常响应: choices 为空或格式错误 - ${JSON.stringify(data).slice(0, 200)}`,
        );
      }
      const choice = data.choices[0];
      const message = choice.message as AssistantMessage;

      const reasoning: string[] = (message.reasoning_details || []).map(
        (detail: ReasoningDetail) => detail.text,
      );

      return {
        content: message.content || "",
        toolCalls: message.tool_calls || [],
        finishReason: choice.finish_reason,
        reasoning,
        rawMessage: {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.tool_calls || [],
          reasoning_details: message.reasoning_details || [],
        },
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("MiniMax API 请求超时（60秒）");
      }
      throw err;
    }
  }

  async *chatStream(messages: MiniMaxMessage[], tools?: object[]): AsyncGenerator<StreamChunk> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
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
      let lastContent = "";
      const lastReasoningByKey = new Map<string, string>();
      const pendingToolCalls = new Map<string, ToolCall>();
      const indexToToolId = new Map<number, string>();

      function* processLine(line: string): Generator<StreamChunk> {
        if (!line.startsWith("data: ")) return;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          for (const tc of pendingToolCalls.values()) {
            yield { type: "tool_call", toolCall: tc, done: false };
          }
          pendingToolCalls.clear();
          yield { type: "done", done: true };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) return;

          const delta = choice.delta as MiniMaxDelta | undefined;

          if (delta?.reasoning_details?.length) {
            for (const detail of delta.reasoning_details) {
              const reasoningText = detail.text || "";
              const key = detail.id ?? String(detail.index ?? 0);
              const previous = lastReasoningByKey.get(key) || "";
              const reasoningChunk = getStreamTextChunk(reasoningText, previous);
              lastReasoningByKey.set(key, reasoningText);
              if (reasoningChunk) {
                yield { type: "reasoning", reasoning: reasoningChunk, done: false };
              }
            }
          }

          // tool_calls：首包常带 id+name；后续 arguments 可能只有 index（OpenAI 兼容 SSE）
          if (delta?.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              if (tc.id && tc.function?.name) {
                const toolCall: ToolCall = {
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || "",
                  },
                };
                pendingToolCalls.set(tc.id, toolCall);
                if (tc.index !== undefined) {
                  indexToToolId.set(tc.index, tc.id);
                }
              } else {
                const resolvedId =
                  tc.id ?? (tc.index !== undefined ? indexToToolId.get(tc.index) : undefined);
                if (resolvedId && tc.function?.arguments) {
                  const existing = pendingToolCalls.get(resolvedId);
                  if (existing) {
                    existing.function.arguments += tc.function.arguments;
                  }
                }
              }
            }
          }

          // yield 已完成 arguments 的 tool_call（arguments 必须以}结尾才算完整）
          for (const [id, tc] of pendingToolCalls) {
            const args = tc.function.arguments;
            if (args.endsWith("}")) {
              try {
                JSON.parse(args); // 验证是有效 JSON
                pendingToolCalls.delete(id);
                yield { type: "tool_call", toolCall: tc, done: false };
              } catch {
                // JSON 不完整，继续等
              }
            }
          }

          if (delta?.content) {
            const contentChunk = getStreamTextChunk(delta.content, lastContent);
            lastContent = delta.content;
            if (contentChunk) {
              yield { type: "content", content: contentChunk, done: false };
            }
          }

          // 检查是否结束（stop 或 tool_calls 后连接可能立即关闭，故在循环外也会 flush）
          if (choice.finish_reason === "stop") {
            for (const tc of pendingToolCalls.values()) {
              yield { type: "tool_call", toolCall: tc, done: false };
            }
            pendingToolCalls.clear();
            yield { type: "done", done: true };
          }
        } catch (e) {
          // 忽略解析错误，继续处理下一行
          console.warn("Failed to parse SSE data:", e);
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            for (const chunk of processLine(line)) {
              yield chunk;
              if (chunk.done) return;
            }
          }
        }

        if (buffer.trim()) {
          for (const chunk of processLine(buffer)) {
            yield chunk;
            if (chunk.done) return;
          }
        }

        // 连接正常结束但未收到 [DONE] / stop：补发尚未 yield 的 tool_call（含 arguments 未以 } 结尾的拼接结果）
        for (const tc of pendingToolCalls.values()) {
          yield { type: "tool_call", toolCall: tc, done: false };
        }
        pendingToolCalls.clear();
        yield { type: "done", done: true };
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("MiniMax API 请求超时（120秒）");
      }
      throw err;
    }
  }
}
