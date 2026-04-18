import { MiniMaxClient } from './minimax-client';
import { GITHUB_TOOLS } from './tools-schema';
import { executeTool, ToolContext } from './dispatch';
import { GitHubClient } from './tools/github';
import { SSEEmitter } from '~/server/lib/sse';
import type { AgentContext } from '~/shared/types';

type MiniMaxMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: MiniMaxToolCall[] }
  | { role: 'tool'; tool_call_id: string; name?: string; content: string };

interface MiniMaxToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const SYSTEM_PROMPT = `你是一个 GitHub 技术画像分析助手。根据 GitHub 公开数据，生成结构化分析报告。

你的任务不是罗列原始数据，而是提炼出有价值的洞察。

数据获取策略：
1. get_user_profile — 获取用户基本信息
2. get_user_repos — 获取仓库列表（判断自建 vs Fork 比例，即开源风格）
3. get_user_events — 获取近 90 天活动事件（判断活跃时段、活跃类型）
4. get_user_stars — 获取 Star 的仓库（判断技术偏好）
5. 某个工具返回空数据时，继续调用其他工具；可以并发调用多个工具提升效率

分析维度（严格按此结构输出报告）：

## 1. 基本信息
用户名、头像、BIO、粉丝数、关注数、公开仓库数。不需要描述数字，直接给出判断。

## 2. 技术画像
- **编程语言**：基于仓库统计语言分布，判断主语言和技术方向
- **项目领域**：通过仓库名称/描述/star 仓库推断，判断偏前端/后端/全栈/AI/基础设施/数据库等哪个方向
- **开源风格**：自建仓库占比 vs Fork 后有提交记录的比例，反映是独立开发者还是社区参与者
- **star 仓库偏好**：star 的仓库反映了什么技术方向和关注领域

## 3. 活跃时间（UTC）
根据事件时间戳分布，判断是工作时间（可能是职业开发者）还是业余时间（可能是个人爱好者），以及活跃度强弱。

## 4. 最近动态（近 90 天）
- 主要活动类型（Push/PR/Issue/Star 等）
- 投入最多的项目
- 关注的技术热点

分析原则：
- 不要罗列原始数据，要提炼洞察和判断
- 给出具体的分析和结论，而不是数字罗列
- 像一个资深开发者在点评，不是在统计数据
- 无数据的模块标注"无公开数据"，不强行生成
- 始终用中文输出报告
`;

const REPORT_PROMPT =
  '基于以下 GitHub 数据，生成一份有洞察力的分析报告。不要罗列原始数据，要给出真正的分析判断。\n\n' +
  '{{DATA}}\n\n' +
  '请按以下格式撰写分析报告，必须严格遵循 Markdown 语法：\n\n' +
  '---\n' +
  '# {{USERNAME}} GitHub 深度分析报告\n\n' +
  '## 1. 技术栈与专长领域\n\n' +
  '### 技术路径\n' +
  '| 阶段 | 时间特征 | 技术栈 | 说明 |\n' +
  '|------|----------|--------|------|\n' +
  '| - | - | - | - |\n\n' +
  '### 技术栈扩展\n' +
  '```\n' +
  '[用 ASCII 箭头展示技术路径，例如：]\n' +
  'JS --> TS --> AI/Agent\n' +
  '  \\\\       /\n' +
  '   \\\\     /\n' +
  '    Angular --> React --> Fullstack\n' +
  '```\n\n' +
  '**核心结论：**\n' +
  '[一句话总结技术路径]\n\n' +
  '## 2. 近期关注方向\n\n' +
  '### 核心焦点\n' +
  '| 类别 | 关注项目 | 意图推断 |\n' +
  '|------|----------|----------|\n' +
  '| - | - | - |\n\n' +
  '### 其他关注\n' +
  '- [列表项]\n\n' +
  '## 3. 技术偏好\n\n' +
  '### 偏好类型\n' +
  '| 偏好 | 表现 | 解读 |\n' +
  '|------|------|------|\n' +
  '| - | - | - |\n\n' +
  '**核心判断：**\n' +
  '[总结判断]\n\n' +
  '## 4. 值得关注的项目\n\n' +
  '| 项目 | 语言 | Stars | 价值 |\n' +
  '|------|------|-------|------|\n' +
  '| - | - | - | - |\n\n' +
  '## 5. 总结\n\n' +
  '**一句话定位：**\n' +
  '[用一句精炼的话总结]\n\n' +
  '---\n\n' +
  '格式要求（必须遵守）：\n' +
  '1. 所有图表/路径图必须用 ``` 代码块包裹，否则会被渲染错误\n' +
  '2. 用表格呈现结构化数据，表格要用 | 分隔\n' +
  '3. 用 **粗体** 突出关键洞察和结论\n' +
  '4. 不要大段连续文字，用列表和表格分隔信息\n' +
  '5. 像资深开发者在点评，不要罗列原始数据';

function constructDataSummary(ctx: AgentContext): string {
  const parts: string[] = [];

  if (ctx.profile) {
    parts.push(`【用户信息】
用户名: ${ctx.profile.login}
简介: ${ctx.profile.bio || '无'}
粉丝: ${ctx.profile.followers} | 关注: ${ctx.profile.following} | 仓库: ${ctx.profile.publicRepos}`);
  }

  if (ctx.repos.length > 0) {
    const topRepos = ctx.repos.slice(0, 15);
    const repoList = topRepos.map(r => {
      const lang = r.language || '未知';
      const stars = r.stargazersCount;
      const desc = r.description || '无描述';
      return `- ${r.name} (${lang}, ★${stars}): ${desc}`;
    }).join('\n');
    parts.push(`【仓库列表】（共 ${ctx.repos.length} 个公开仓库）
${repoList}`);
  }

  if (ctx.events.length > 0) {
    const recentEvents = ctx.events.slice(0, 20);
    const eventList = recentEvents.map(e => {
      const time = new Date(e.createdAt).toISOString().split('T')[0];
      const repo = e.repo?.name || '未知仓库';
      return `- [${e.type}] ${time} @ ${repo}`;
    }).join('\n');
    parts.push(`【近期活动】（共 ${ctx.events.length} 条）
${eventList}`);
  }

  if (ctx.stars.length > 0) {
    const topStars = ctx.stars.slice(0, 15);
    const starList = topStars.map(s => {
      const lang = s.language || '未知';
      const desc = s.description || '无描述';
      return `- ${s.fullName} (${lang}): ${desc}`;
    }).join('\n');
    parts.push(`【Star 的仓库】（共 ${ctx.stars.length} 个）
${starList}`);
  }

  return parts.join('\n\n');
}

function generateSummary(toolName: string, result: unknown): string {
  if (!result) return '⚠️ 无数据';

  switch (toolName) {
    case 'get_user_profile': {
      const p = result as { login: string };
      return `✅ 获取到用户 ${p.login}`;
    }
    case 'get_user_repos': {
      const arr = result as unknown[];
      return `✅ 获取到 ${arr.length} 个仓库`;
    }
    case 'get_user_events': {
      const arr = result as unknown[];
      return `✅ 获取到 ${arr.length} 条活动`;
    }
    case 'get_user_stars': {
      const arr = result as unknown[];
      return `✅ 获取到 ${arr.length} 个 Star`;
    }
    default:
      return Array.isArray(result)
        ? `✅ 获取到 ${result.length} 条数据`
        : '✅ 执行成功';
  }
}

export async function runAgentLoop(githubId: string, emitter: SSEEmitter): Promise<void> {
  const minimaxClient = new MiniMaxClient(process.env.MINIMAX_API_KEY || '');
  const githubClient = new GitHubClient(process.env.GITHUB_TOKEN || '');
  const cleanId = githubId.trim();

  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `分析 GitHub 用户: ${cleanId}` },
  ];

  const allTools = GITHUB_TOOLS;

  const agentCtx: AgentContext = {
    githubId: cleanId,
    profile: null,
    repos: [],
    events: [],
    stars: [],
  };

  const toolCtx: ToolContext = {
    githubId: cleanId,
    emitter,
    githubClient,
    agentCtx,
  };

  const MAX_ITERATIONS = 10;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    await emitter.emit('step', JSON.stringify({
      iteration: iterations,
      maxIterations: MAX_ITERATIONS,
    }));

    const response = await minimaxClient.chat(messages, allTools);
    const { content, toolCalls, finishReason } = response;

    if (finishReason !== 'tool_calls') {
      // Skip emitting "正在生成洞察分析..." since GeneratingHint already shows this
      const dataSummary = constructDataSummary(agentCtx);

      const analysisMessages = [
        { role: 'system' as const, content: SYSTEM_PROMPT },
        { role: 'user' as const, content: REPORT_PROMPT.replace('{{DATA}}', dataSummary).replace('{{USERNAME}}', cleanId) },
      ];

      const analysisResponse = await minimaxClient.chat(analysisMessages, []);
      const analysisContent = analysisResponse.content || '无法生成分析报告';

      await emitter.emit('final_report', analysisContent);
      await emitter.emit('done', '');
      return;
    }

    if (response.reasoning?.length) {
      await emitter.emit('thinking', `LLM 思考: ${response.reasoning.join(' ')}`);
    }

    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const name = toolCall.function.name;
        const id = toolCall.id;
        const input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

        await emitter.emit('tool_start', JSON.stringify({
          toolCallId: id,
          toolName: name,
          input,
        }));

        const execResult = await executeTool(name, input, toolCtx);

        const summary = generateSummary(name, execResult.result);
        await emitter.emit('tool_end', JSON.stringify({
          toolCallId: id,
          toolName: name,
          toolSuccess: execResult.success,
          result: execResult.result,
          summary,
          error: execResult.error,
        }));

        return { id, name, input, ...execResult };
      })
    );

    const assistantMessage: MiniMaxMessage = {
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };
    messages.push(assistantMessage);

    for (const tr of toolResults) {
      const { id, name, success, result, error } = tr;
      messages.push({
        role: 'tool',
        tool_call_id: id,
        name: name,
        content: success ? JSON.stringify(result) : JSON.stringify({ error }),
      });
    }

    for (const tr of toolResults) {
      if (tr.logs) {
        for (const log of tr.logs) {
          await emitter.emit('observation', JSON.stringify({
            content: log,
            toolCallId: tr.id,
          }));
        }
      }
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    await emitter.emit('error', '分析复杂度超出限制，请稍后重试。');
  }

  await emitter.emit('done', '');
}
