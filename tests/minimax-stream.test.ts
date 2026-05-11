import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { MiniMaxClient, type StreamChunk } from "~/server/agent/minimax-client";

describe("MiniMaxClient.chatStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockFetchWithSse(bodyText: string) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(bodyText));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      ),
    );
  }

  it("flushes pending tool_calls when stream ends without [DONE] (incomplete JSON arguments)", async () => {
    const payload = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "call_x",
                index: 0,
                function: { name: "get_user_profile", arguments: '{"username": "a' },
              },
            ],
          },
        },
      ],
    };
    mockFetchWithSse(`data: ${JSON.stringify(payload)}\n\n`);
    const client = new MiniMaxClient("test-key");
    const chunks: StreamChunk[] = [];
    for await (const c of client.chatStream([{ role: "user", content: "hi" }], [])) {
      chunks.push(c);
    }
    const tools = chunks.filter(
      (c): c is Extract<StreamChunk, { type: "tool_call" }> => c.type === "tool_call",
    );
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].toolCall.function.name).toBe("get_user_profile");
    expect(tools[0].toolCall.id).toBe("call_x");
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it("yields one tool_call and done for complete JSON when connection closes without [DONE]", async () => {
    const payload = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "c1",
                index: 0,
                function: { name: "get_user_profile", arguments: "{}" },
              },
            ],
          },
        },
      ],
    };
    mockFetchWithSse(`data: ${JSON.stringify(payload)}\n\n`);
    const client = new MiniMaxClient("test-key");
    const chunks: StreamChunk[] = [];
    for await (const c of client.chatStream([{ role: "user", content: "hi" }], [])) {
      chunks.push(c);
    }
    const toolCalls = chunks.filter((c) => c.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it("flushes on [DONE] after tool_calls with arguments split across deltas (index resolution)", async () => {
    const line1 = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "t2",
                index: 0,
                function: { name: "get_user_repos", arguments: "" },
              },
            ],
          },
        },
      ],
    });
    const line2 = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: JSON.stringify({ username: "u" }) },
              },
            ],
          },
        },
      ],
    });
    const line3 = JSON.stringify({
      choices: [{ finish_reason: "tool_calls", delta: {} }],
    });
    const sse = [
      `data: ${line1}`,
      "",
      `data: ${line2}`,
      "",
      `data: ${line3}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    mockFetchWithSse(sse);
    const client = new MiniMaxClient("test-key");
    const chunks: StreamChunk[] = [];
    for await (const c of client.chatStream([{ role: "user", content: "hi" }], [])) {
      chunks.push(c);
    }
    const toolCalls = chunks.filter((c) => c.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    const lastTool = toolCalls[toolCalls.length - 1] as Extract<StreamChunk, { type: "tool_call" }>;
    expect(JSON.parse(lastTool.toolCall.function.arguments)).toEqual({ username: "u" });
  });
});
