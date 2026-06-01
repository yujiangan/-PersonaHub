import { defineEventHandler, getQuery, createError, setHeaders } from "h3";
import { createSSEStream } from "~/server/lib/sse";
import { runAgentLoop } from "~/server/agent/agent-loop";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const githubId = query.githubId as string | undefined;

  if (!githubId) {
    throw createError({ status: 400, message: "缺少 githubId 参数" });
  }

  const validUsernamePattern = /^[a-zA-Z0-9_-]+$/;
  if (!validUsernamePattern.test(githubId)) {
    throw createError({ status: 400, message: "GitHub ID 格式不正确" });
  }

  if (!process.env.GITHUB_TOKEN) {
    throw createError({ status: 500, message: "服务器配置错误：未设置 GITHUB_TOKEN" });
  }

  if (!process.env.MINIMAX_API_KEY) {
    throw createError({ status: 500, message: "服务器配置错误：未设置 MINIMAX_API_KEY" });
  }

  const { stream, emitter } = createSSEStream();

  runAgentLoop(githubId, emitter).catch(async (err) => {
    console.error("Agent 错误:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      await emitter.emit("error", `服务异常: ${errorMessage}`);
    } catch (emitErr) {
      console.error("emit error 失败:", emitErr);
    }
    try {
      await emitter.emit("done", "");
    } catch (emitErr) {
      console.error("emit done 失败:", emitErr);
    }
  });

  setHeaders(event, {
    "Content-Type": "text/event-stream",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
  });

  return stream;
});
