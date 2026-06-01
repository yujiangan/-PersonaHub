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

  async function collectChunks(bodyText: string) {
    mockFetchWithSse(bodyText);
    const client = new MiniMaxClient("test-key");
    const chunks: StreamChunk[] = [];
    for await (const c of client.chatStream([{ role: "user", content: "hi" }], [])) {
      chunks.push(c);
    }
    return chunks;
  }

  function sseData(payloads: unknown[]) {
    return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n`).join("\n");
  }

  it("does not truncate content deltas that are not cumulative prefixes", async () => {
    const chunks = await collectChunks(
      sseData([
        { choices: [{ delta: { content: "我是" } }] },
        { choices: [{ delta: { content: "一个开发者" } }] },
        { choices: [{ finish_reason: "stop", delta: {} }] },
      ]),
    );

    const content = chunks
      .filter((c): c is Extract<StreamChunk, { type: "content" }> => c.type === "content")
      .map((c) => c.content)
      .join("");

    expect(content).toBe("我是一个开发者");
  });

  it("still emits only appended content when MiniMax sends cumulative text", async () => {
    const chunks = await collectChunks(
      sseData([
        { choices: [{ delta: { content: "我是" } }] },
        { choices: [{ delta: { content: "我是一个开发者" } }] },
        { choices: [{ finish_reason: "stop", delta: {} }] },
      ]),
    );

    const contents = chunks
      .filter((c): c is Extract<StreamChunk, { type: "content" }> => c.type === "content")
      .map((c) => c.content);

    expect(contents).toEqual(["我是", "一个开发者"]);
  });

  it("does not drop reasoning_details after the first item", async () => {
    const chunks = await collectChunks(
      sseData([
        {
          choices: [
            {
              delta: {
                reasoning_details: [
                  { id: "r1", index: 0, text: "先看仓库" },
                  { id: "r2", index: 1, text: "再看贡献" },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                reasoning_details: [
                  { id: "r1", index: 0, text: "先看仓库结构" },
                  { id: "r2", index: 1, text: "再看贡献记录" },
                ],
              },
            },
          ],
        },
        { choices: [{ finish_reason: "stop", delta: {} }] },
      ]),
    );

    const reasoning = chunks
      .filter((c): c is Extract<StreamChunk, { type: "reasoning" }> => c.type === "reasoning")
      .map((c) => c.reasoning);

    expect(reasoning).toEqual(["先看仓库", "再看贡献", "结构", "记录"]);
  });

  it("processes the final data line even when the stream has no trailing newline", async () => {
    const chunks = await collectChunks(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "最后一段" } }] })}`,
    );

    const content = chunks.find(
      (c): c is Extract<StreamChunk, { type: "content" }> => c.type === "content",
    );

    expect(content?.content).toBe("最后一段");
  });

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
