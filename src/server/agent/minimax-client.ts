const OPENAI_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'MiniMax-M2.7';
const DEFAULT_MAX_TOKENS = 16000;

export interface ToolCall {
  id: string;
  type: 'function';
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
  role: 'assistant';
  content: string | null;
  tool_calls: ToolCall[];
  reasoning_details: ReasoningDetail[];
}

export interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type MiniMaxMessage = AssistantMessage | ToolMessage | { role: 'system' | 'user'; content: string };

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  reasoning: string[];
  rawMessage: AssistantMessage;
}

export class MiniMaxClient {
  private baseUrl = OPENAI_BASE_URL;

  constructor(
    private apiKey: string,
    private model: string = DEFAULT_MODEL,
    private maxTokens: number = DEFAULT_MAX_TOKENS
  ) {}

  async chat(messages: MiniMaxMessage[], tools?: object[]): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
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

      const data = await response.json() as any;
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error(`MiniMax API 异常响应: choices 为空或格式错误 - ${JSON.stringify(data).slice(0, 200)}`);
      }
      const choice = data.choices[0];
      const message = choice.message as AssistantMessage;

      const reasoning: string[] = (message.reasoning_details || []).map(
        (detail: ReasoningDetail) => detail.text
      );

      return {
        content: message.content || '',
        toolCalls: message.tool_calls || [],
        finishReason: choice.finish_reason,
        reasoning,
        rawMessage: {
          role: 'assistant',
          content: message.content || null,
          tool_calls: message.tool_calls || [],
          reasoning_details: message.reasoning_details || [],
        },
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('MiniMax API 请求超时（60秒）');
      }
      throw err;
    }
  }
}
