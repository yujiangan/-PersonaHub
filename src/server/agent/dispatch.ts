import { GitHubClient } from "./tools/github";
import { getUserProfile } from "./tools/get-profile";
import { getUserRepos } from "./tools/get-repos";
import { getUserEvents } from "./tools/get-events";
import { getUserStars } from "./tools/get-stars";
import type { SSEEmitter } from "~/server/lib/sse";
import type { AgentContext } from "~/shared/types";

export interface ToolContext {
  githubId: string;
  emitter: SSEEmitter;
  githubClient: GitHubClient;
  agentCtx: AgentContext;
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
  logs?: string[];
}

export type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_user_profile: async (input, context) => {
    const username = String(input.username || "").trim();
    const logs: string[] = [];
    logs.push(`正在获取用户 ${username} 的资料...`);
    const result = await getUserProfile(context.githubClient, { username });
    context.agentCtx.profile = result;
    logs.push(`获取到用户资料：${result.login}`);
    return { success: true, result, logs };
  },

  get_user_repos: async (input, context) => {
    const username = String(input.username || "").trim();
    const logs: string[] = [];
    logs.push(`正在获取用户 ${username} 的仓库...`);
    const result = await getUserRepos(context.githubClient, { username });
    context.agentCtx.repos = result;
    logs.push(`获取到 ${result.length} 个仓库`);
    return { success: true, result, logs };
  },

  get_user_events: async (input, context) => {
    const username = String(input.username || "").trim();
    const logs: string[] = [];
    logs.push(`正在获取用户 ${username} 的活动事件...`);
    const result = await getUserEvents(context.githubClient, { username });
    context.agentCtx.events = result;
    logs.push(`获取到 ${result.length} 条事件`);
    return { success: true, result, logs };
  },

  get_user_stars: async (input, context) => {
    const username = String(input.username || "").trim();
    const logs: string[] = [];
    logs.push(`正在获取用户 ${username} 的 stars...`);
    const result = await getUserStars(context.githubClient, { username });
    context.agentCtx.stars = result;
    logs.push(`获取到 ${result.length} 个 stars`);
    return { success: true, result, logs };
  },
};

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return { success: false, error: `Unknown tool: ${toolName}`, logs: [] };
  }
  try {
    return await handler(toolInput, context);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Remove "Error: " prefix if present for cleaner display
    const cleanMsg = errorMsg.replace(/^Error:\s*/i, "");
    return { success: false, error: cleanMsg, logs: [`工具执行异常: ${cleanMsg}`] };
  }
}
