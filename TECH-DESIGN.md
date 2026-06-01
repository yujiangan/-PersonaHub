# PersonaHub — 技术设计文档

> 本文档面向开发者，定义系统架构、模块边界、接口契约与实现细节。
> 代码实现详见对应源文件，文档只引用路径不做内联。

**与当前代码对齐（主线）**：分析流程由 `src/server/agent/agent-loop.ts` 的 `runAgentLoop()` 驱动——工具阶段通过 MiniMax 流式 `chatStream` 决策并调用 `dispatch.ts` 注册的 GitHub 工具；数据齐备后进入报告阶段，按 `REPORT_PROMPT`（对齐 PRD 四章）流式输出 `report_chunk`。SSE 事件类型以 `src/shared/types.ts` 的 `SSEEventType` 为准。下文若仍出现 `reactor.ts`、`report-builder.ts` 等文件名，为早期设计描述，以仓库内实际路径为准。

---

## 1. 技术选型

| 层级       | 技术                 | 版本要求 | 用途                    |
| ---------- | -------------------- | -------- | ----------------------- |
| 构建工具   | VitePlus             | ^3.x     | 前端开发服务器与构建    |
| React 插件 | @vitejs/plugin-react | ^4.x     | React 17+ JSX Transform |
| 服务端框架 | Nitro                | ^3.x     | API Routes、SSR、SSE    |
| 语言       | TypeScript           | ^5.x     | 全栈类型安全            |
| 流式协议   | Server-Sent Events   | —        | 服务端→客户端实时推送   |

### 1.1 技术选型理由

- **VitePlus**: 基于 Vite 的轻量增强，保留 Vite 原生 DX，plugin-react 兼容 React 生态。
- **Nitro**: 极简服务端框架，支持任意运行时（Node.js / Cloudflare Workers / Vercel），API 设计与 H3 兼容。
- **LLM 编排 + 工具调用**：由 MiniMax 完成工具选择与报告撰写，GitHub 访问仍走服务端工具层。

### 1.2 技术约束

- GitHub Token 配置于服务端环境变量（`GITHUB_TOKEN`），不暴露给客户端
- 单次分析请求超时：60 秒
- 无会话持久化，每次请求独立完整分析
- GitHub API 速率限制：5000 req/hour（认证后）

---

## 2. 项目结构

```
personahub/
├── src/
│   ├── app/                         # VitePlus 前端入口
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── index.html
│   │   ├── components/
│   │   │   ├── SearchBar.tsx
│   │   │   ├── AgentStream.tsx     # 思考流 + 工具卡片 + Markdown 报告
│   │   │   └── …
│   │   └── hooks/
│   │       └── useAnalysis.ts      # SSE 客户端 Hook
│   │
│   ├── server/                      # Nitro 服务端
│   │   ├── api/
│   │   │   └── analyze.get.ts      # GET /api/analyze
│   │   ├── agent/
│   │   │   ├── agent-loop.ts       # runAgentLoop：工具轮 + 报告轮
│   │   │   ├── minimax-client.ts   # MiniMax 流式 / 非流式 API
│   │   │   ├── tools-schema.ts     # 工具 JSON Schema
│   │   │   ├── dispatch.ts         # 工具注册与执行
│   │   │   └── tools/
│   │   │       ├── github.ts       # GitHubClient
│   │   │       ├── get-profile.ts
│   │   │       ├── get-repos.ts
│   │   │       ├── get-events.ts
│   │   │       └── get-stars.ts
│   │   └── lib/
│   │       └── sse.ts              # SSE Emitter
│   └── shared/
│       └── types.ts                # 跨端类型定义
├── package.json
├── nitro.config.ts
├── vite.config.ts
└── tsconfig.json
```

---

## 3. 共享类型定义

详见 `src/shared/types.ts`。

### 3.1 核心类型

```typescript
// GitHubUser — 用户基本信息（PRD「基本信息」维度）
interface GitHubUser {
  login: string; // GitHub 用户名，用于查询和展示
  avatarUrl: string;
  bio: string | null;
  publicRepos: number;
  followers: number;
  following: number;
  createdAt: string; // ISO 8601
}

// GitHubRepo — 仓库信息
interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  stargazersCount: number;
  forksCount: number;
  topics: string[];
  fork: boolean;
  createdAt: string;
  updatedAt: string;
}

// GitHubEvent — 用户活动事件（90 天动态数据来源）
interface GitHubEvent {
  id: string;
  type: GitHubEventType;
  repo: { name: string; url: string };
  payload: Record<string, unknown>;
  createdAt: string; // ISO 8601，用于 90 天过滤
}

// GitHubStarredRepo — Starred 仓库
interface GitHubStarredRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stargazersCount: number;
}
```

### 3.2 SSE 事件格式

详见 `src/shared/types.ts` 中的 `SSEEventType`。载荷统一为 `{ type, content, timestamp }`（`timestamp` 为 Unix 毫秒）。

**当前实现常用事件**：

| type                      | 触发时机                    | content 含义                                           |
| ------------------------- | --------------------------- | ------------------------------------------------------ |
| `thinking_chunk`          | MiniMax 流式 reasoning 增量 | 思考文本片段（工具阶段侧重选工具；报告阶段可继续追加） |
| `thinking_done`           | 单轮流式结束                | 空或占位                                               |
| `tool_start` / `tool_end` | 工具执行前后                | JSON 字符串（含 toolCallId、summary 等）               |
| `observation`             | 工具执行日志                | JSON 或摘要文本                                        |
| `step`                    | Agent 迭代轮次              | JSON（iteration 等）                                   |
| `report_chunk`            | 报告正文流式增量            | Markdown 片段                                          |
| `report_done`             | 报告流结束                  | 空                                                     |
| `error` / `done`          | 错误或整条 SSE 收尾         | 用户可读文案 / 空                                      |

兼容保留：`thinking`、`final_report` 等类型定义仍在类型联合中，前端可按需监听。

**observation**（当前）：多为工具 `logs` 数组中的单行说明，非早期「Phase 枚举」结构。

### 3.3 Agent 核心类型

```typescript
// Phase — Agent 执行阶段
type Phase =
  | "INIT"
  | "FETCHING_PROFILE"
  | "FETCHING_REPOS"
  | "FETCHING_EVENTS"
  | "FETCHING_STARS"
  | "BUILDING_REPORT"
  | "DONE"
  | "ERROR";

// AnalysisContext — ReAct 主循环上下文，各 Phase 间传递数据
interface AnalysisContext {
  username: string; // GitHub 用户名，用于 API 查询
  phase: Phase;
  profile: GitHubUser | null; // 无数据时为 null，不中断
  repos: GitHubRepo[]; // 无数据时为 []
  events: GitHubEvent[]; // 无数据时为 []
  stars: GitHubStarredRepo[]; // 无数据时为 []
  error: GitHubError | null; // 当前模块错误，不中断后续模块
  startedAt: number; // Unix ms，用于超时检测
}

// SchedulerOutput — Scheduler 返回值
interface SchedulerOutput {
  nextPhase: Phase;
  execute: () => Promise<void>; // 异步执行函数
}

// GitHubError — GitHub API 错误
class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
  }
}
```

---

## 4. 系统架构

### 4.1 Agent 主循环（实现概要）

实现见 `src/server/agent/agent-loop.ts` 中 `runAgentLoop()`：

1. 校验用户存在后，进入 `while` 迭代：每轮对 MiniMax `chatStream(messages, tools)` 消费流式片段；`reasoning` 经 `thinking_chunk` 推给前端；完整 `tool_call` 经累积后执行 `executeTool`。
2. 若有工具调用：写入 `messages` 后继续下一轮；若无：视为数据已齐，构造 `constructDataSummary(agentCtx)`，用 `REPORT_PROMPT`（对齐 PRD 四章）发起第二次 `chatStream`，`content` → `report_chunk`，`reasoning` 仍可 → `thinking_chunk`，最后 `report_done` 与 `done`。

**关键设计**：

- 工具阶段 system 提示（`TOOL_AGENT_SYSTEM`）约束 reasoning 只做「选工具」叙述，禁止复述工具返回正文。
- 报告阶段 system / user（`REPORT_AGENT_SYSTEM` + `REPORT_PROMPT`）约束输出为合法 Markdown 与 PRD 四个一级章节。
- 异常路径在 `analyze.get.ts` 中应尽量 `error` 后补 `done`，避免前端悬挂。

### 4.2 数据流

```
用户输入 GitHub username
        │
        ▼
┌───────────────────┐
│   /api/analyze    │  ← Nitro API Route
│   (analyze.get.ts)│
└─────────┬─────────┘
          │ 创建 SSE Stream
          ▼
┌───────────────────┐
│  runAgentLoop()   │  ← agent-loop.ts（MiniMax + 工具）
│                   │
│  ┌─────────────────────────────┐
│  │  dispatch / tools (GitHub)   │
│  └─────────────┬───────────────┘
│                │ 数据写入 AgentContext
│                ▼
│  ┌───────────────────────┐
│  │  第二段 chatStream      │  ← REPORT_PROMPT → report_chunk
│  └───────────┬───────────┘
│              │ report_done / done
└──────────────┼──────────────┘
               ▼
        SSE 推送到前端
```

### 4.3 报告维度（对齐 PRD）

报告须包含以下四个模块（由 `REPORT_PROMPT` 约束 LLM 输出；数据来自 `constructDataSummary`）：

| 维度     | 说明                                                          | 数据来源                        |
| -------- | ------------------------------------------------------------- | ------------------------------- |
| 技术画像 | 编程语言 Top N、项目领域、开源风格（自建/协作比例）、偏好技术 | repos + stars                   |
| 活跃时间 | 活跃时段（工作日/周末/均衡）、高峰小时（UTC）                 | events                          |
| 最近动态 | 90 天内活动数、事件类型分布、活跃项目、技术热点               | events（created_at >= 90 天前） |
| 基本信息 | 用户名（login）、头像、Bio、粉丝数、仓库数等                  | profile                         |

**技术画像详细说明**：

- **编程语言 Top N**：统计所有 repos 中 `language` 字段的出现频率，按降序取前 5，百分比 = 该语言仓库数 / 有语言标注的仓库总数。

- **项目领域**：通过 repos 的仓库名称、描述、topics 推断项目所属领域（如：Web 开发、AI 工具、DevOps 基础设施等）。（若存在手写报告生成器，可在 `report-builder.ts` 中实现类似 `analyzeProjectDomains` 的辅助逻辑；当前主线以 LLM 按 PRD 叙述为准。）

- **开源风格计算**：
  - 自建仓库 = `fork === false` 的仓库数
  - 协作仓库 = `fork === true` 的仓库数
  - 自建比例 = 自建仓库数 / 总仓库数（百分比）

  > **口径说明**：本期使用 `fork` 字段做近似估算，fork === true 仅表示该仓库是从他人项目复制而来，不严格识别真实协作行为（如 fork 后有提交记录或加入了 Organization）。

- **偏好技术**：通过 stars 仓库的 topics 与描述归纳；由 `REPORT_PROMPT` 要求模型在「二、技术画像」中表述。

**90 天时间范围**：可在工具层按 `Date.now() - 90 * 24 * 60 * 60 * 1000` 对比 `createdAt` 过滤 `events` 后再写入摘要；或在提示词中要求模型仅依据近 90 天数据描述「四、最近动态」。

**「无公开数据」处理**：任一维度数据为空时（如 events=[]），该维度在报告中标注"无公开数据"，不显示为空或报错。

### 4.4 Scheduler（伪代码）

```typescript
function schedule(ctx: AnalysisContext, client: GitHubClient): SchedulerOutput {
  switch (ctx.phase) {
    case "INIT":
      return {
        nextPhase: "FETCHING_PROFILE",
        execute: () => {
          ctx.profile = await getUserProfile(client, ctx.username);
        },
      };
    case "FETCHING_PROFILE":
      return {
        nextPhase: "FETCHING_REPOS",
        execute: () => {
          ctx.repos = await getUserRepos(client, ctx.username);
        },
      };
    case "FETCHING_REPOS":
      return {
        nextPhase: "FETCHING_EVENTS",
        execute: () => {
          ctx.events = await getUserEvents(client, ctx.username);
        },
      };
    case "FETCHING_EVENTS":
      return {
        nextPhase: "FETCHING_STARS",
        execute: () => {
          ctx.stars = await getUserStars(client, ctx.username);
        },
      };
    case "FETCHING_STARS":
      return { nextPhase: "BUILDING_REPORT", execute: () => {} }; // 以下为早期 Scheduler 伪代码；当前实现见 agent-loop
  }
}
```

状态转移固定顺序，详见 `src/server/agent/scheduler.ts`。

### 4.5 Agent 阶段定义

| Phase              | 说明              | 出错策略                     |
| ------------------ | ----------------- | ---------------------------- |
| `INIT`             | 初始化            | —                            |
| `FETCHING_PROFILE` | 获取用户资料      | 降级：profile 为 null 仍继续 |
| `FETCHING_REPOS`   | 获取仓库列表      | 降级：repos 为空数组仍继续   |
| `FETCHING_EVENTS`  | 获取活动时间线    | 降级：events 为空数组仍继续  |
| `FETCHING_STARS`   | 获取 Starred 仓库 | 降级：stars 为空数组仍继续   |
| `BUILDING_REPORT`  | 生成报告          | —                            |
| `DONE`             | 完成              | —                            |
| `ERROR`            | 出错              | —                            |

**降级策略**：任一模块失败不中断整次分析，错误记录在 `ctx.error`，后续模块继续执行，最终报告生成时会利用已有数据。

---

## 5. SSE 协议

### 5.1 服务端发送格式（伪代码）

```typescript
async emit(type: SSEEvent['type'], content: string): void {
  const event: SSEEvent = { type, content, timestamp: Date.now() };
  // SSE 协议：event: <type>\ndata: <json>\n\n
  controller.enqueue(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}
```

每个事件发送命名 SSE 事件，详见 `src/server/lib/sse.ts`。

### 5.2 流式进度与「思考区」

- **工具阶段**：`thinking_chunk` 承载模型 reasoning（产品文案为「AI 思考中」）；`tool_*` / `observation` 反映工具执行。
- **报告阶段**：`report_chunk` 为 Markdown 正文；报告阶段的 reasoning 仍可经 `thinking_chunk` 追加，思考区不随报告开始而被清空（见 `useAnalysis` 与 `AgentStream`）。

### 5.3 前端接收方式

前端必须使用 `addEventListener` 监听命名事件，不能使用 `onmessage`。除 `thinking` / `final_report` 外，还需处理 `thinking_chunk`、`report_chunk`、`report_done`、`tool_start`、`tool_end` 等，详见 `src/app/hooks/useAnalysis.ts`。

---

## 6. 错误处理（伪代码）

```typescript
function mapErrorToUserMessage(err: Error): string {
  if (err instanceof GitHubError) {
    switch (err.status) {
      case 404:
        return "用户不存在，请检查 GitHub ID 是否正确。";
      case 403:
        return "API 请求频率超限，请稍后再试。";
      default:
        return `网络异常：${err.message}`;
    }
  }
  return "网络异常，分析失败，请重试。";
}
```

错误文案以 `analyze.get.ts` / `agent-loop.ts` 中实际 emit 为准。

---

## 7. GitHub API 调用

### 7.1 工具函数

| 函数             | 调用的 GitHub API               | 分页规则                              |
| ---------------- | ------------------------------- | ------------------------------------- |
| `getUserProfile` | `GET /users/{username}`         | —                                     |
| `getUserRepos`   | `GET /users/{username}/repos`   | `per_page=100`，最多 5 页（500 条）   |
| `getUserEvents`  | `GET /users/{username}/events`  | `per_page=100`，最多 10 页（1000 条） |
| `getUserStars`   | `GET /users/{username}/starred` | `per_page=100`，最多 10 页（1000 条） |

**分页终止条件**：遇空页即停止（非强制拉满最大页数）。

**字段筛选**：各工具函数只取需要的字段，其余丢弃，减少内存占用。

**分页逻辑**（伪代码）：

```typescript
async function fetchAllPages(client, baseEndpoint, maxPages = 5, perPage = 100) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await client.fetch(`${baseEndpoint}?per_page=${perPage}&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break; // 遇空页停止
    results.push(...data);
    if (data.length < perPage) break; // 不足一页说明已到末尾
  }
  return results;
}
```

详见 `src/server/agent/tools/github.ts` 中的 `fetchAllPages`。

**GitHubClient 单次请求超时（10s）**：使用 `AbortController` + `setTimeout` 实现，超时后抛出 `GitHubError(408, endpoint, 'Request timeout')`。

**GitHubClient 重试策略**：对 403/500/502/503 错误进行指数退避重试（最多 2 次），退避间隔 500ms → 2000ms。

**GitHubClient 核心方法**：

```typescript
class GitHubClient {
  constructor(private readonly token: string) {}

  async fetch<T>(endpoint: string): Promise<T> {
    // 重试逻辑：403/500/502/503 可重试，指数退避最多 2 次
  }

  private async doFetch<T>(endpoint: string): Promise<T> {
    // 单次请求：AbortController 超时 10s，GitHub API 错误映射为 GitHubError
  }
}
```

详见 `src/server/agent/tools/github.ts`。

**两种 403 场景的区分**：

| 403 场景           | 判断方式                  | 用户消息                       |
| ------------------ | ------------------------- | ------------------------------ |
| 单用户请求频率超限 | 单用户短时间内大量请求    | API 请求频率超限，请稍后再试。 |
| Token 配额用尽     | X-RateLimit-Remaining = 0 | 服务繁忙，请稍后再试。         |

判断逻辑：响应头中 `X-RateLimit-Remaining === 0` 时视为配额用尽，否则视为单用户限流。

**「数据为空」与「调用失败」的区别**：

| 场景               | 触发条件                  | observation content 示例 | 是否发送 error             |
| ------------------ | ------------------------- | ------------------------ | -------------------------- |
| 调用成功，数据为空 | API 返回 200 但 body=[]   | "已获取 0 个仓库"        | 否                         |
| 调用失败           | API 返回 404/403/网络错误 | —                        | 是（发送 error，降级继续） |

GitHub 工具层错误映射逻辑见 `src/server/agent/tools/github.ts`；分析流程中的用户可见错误见 `agent-loop.ts` 与 `analyze.get.ts`。

---

## 8. 错误分类与响应

| 错误类型   | 触发条件          | 用户消息                                | HTTP 状态码 |
| ---------- | ----------------- | --------------------------------------- | ----------- |
| 无效输入   | username 格式不符 | GitHub 用户名格式不正确                 | 400         |
| 用户不存在 | GitHub API 404    | 用户不存在，请检查 GitHub ID 是否正确。 | — (SSE)     |
| API 限流   | GitHub API 403    | API 请求频率超限，请稍后再试。          | — (SSE)     |
| 请求超时   | 超过 60s          | 分析超时，请重试。                      | — (SSE)     |
| 网络错误   | fetch 抛出异常    | 网络异常，分析失败，请重试。            | — (SSE)     |
| 服务繁忙   | 未捕获异常        | 服务繁忙，请稍后再试。                  | — (SSE)     |
| 配置错误   | 缺少 GITHUB_TOKEN | (不返回给客户端)                        | 500         |

---

## 9. 前端组件

| 组件          | 职责                                                     |
| ------------- | -------------------------------------------------------- |
| `SearchBar`   | 用户输入 GitHub username，触发分析                       |
| `AgentStream` | 「AI 思考中」流式区 + 工具卡片 + Markdown 报告（含复制） |

详见 `src/app/components/`

---

## 10. 配置文件

### 10.1 vite.config.ts

- 开发服务器代理 `/api` 请求到 `http://localhost:3000`（Nitro 服务）
- 使用 `@vitejs/plugin-react` 支持 React JSX
- 使用 `viteplus` 插件

### 10.2 nitro.config.ts

- `preset: 'node-server'`（开发）、`'vercel'`（生产）
- `routeRules: '/api/**': { cors: true, cacheControl: false }`

### 10.3 本地开发

```bash
# 终端 1：启动前端（Vite）
npm run dev

# 终端 2：启动后端（Nitro）
npm run dev:server

# .env.local
GITHUB_TOKEN=ghp_your_token_here
```

详见 `vite.config.ts`、`nitro.config.ts`。

---

## 11. 性能与资源

- **分页上限**：单用户最多获取 1000 条事件（10 页 × 100 条），分页终止条件为遇空页即停
- **超时控制**：单次 fetch 超时 10s（`REQUEST_TIMEOUT_MS`），全流程超时 60s（`MAX_EXECUTION_MS`），超时后在 ReAct 循环中检测并发送 error 事件后进入 ERROR 阶段
- **并发控制**：服务端不对并发请求做额外限制，完全依赖 GitHub API 速率限制（5000 req/hour）
- **重复提交处理**：用户点击「分析」时，前端先调用 `eventSource.close()` 关闭旧连接，再创建新连接，避免多流同时推送
- **前端防抖**：用户点击后禁用按钮，直到分析完成或出错后才重新启用
- **内存管理**：SSE 流式处理不积累大数据；`AnalysisContext` 在 `runReactor` 返回后由 GC 回收

---

## 12. 部署

### 12.1 环境变量

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
MINIMAX_API_KEY=your_minimax_key
```

**Token 权限要求**：`read:user` + `public_repo`（`GITHUB_TOKEN`）。`MINIMAX_API_KEY` 用于 LLM 调用。

### 12.2 部署平台

推荐 Vercel（通过 `@vercel/nitro` preset），详见 `nitro.config.ts`。

---

## 13. 实现索引

| 设计点         | 源文件                               | 关键导出                                                                  |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| SSE Emitter    | `src/server/lib/sse.ts`              | `SSEEmitter.emit()`, `createSSEStream()`                                  |
| Agent 主循环   | `src/server/agent/agent-loop.ts`     | `runAgentLoop()`                                                          |
| MiniMax 客户端 | `src/server/agent/minimax-client.ts` | `MiniMaxClient.chatStream()`                                              |
| 工具调度       | `src/server/agent/dispatch.ts`       | `executeTool()`, `TOOL_HANDLERS`                                          |
| GitHubClient   | `src/server/agent/tools/github.ts`   | `GitHubClient.fetch()`, `fetchAllPages()`                                 |
| API 入口       | `src/server/api/analyze.get.ts`      | —                                                                         |
| 前端 SSE Hook  | `src/app/hooks/useAnalysis.ts`       | `useAnalysis()`                                                           |
| 共享类型       | `src/shared/types.ts`                | `GitHubUser`, `GitHubRepo`, `GitHubEvent`, `SSEEventType`, `AgentContext` |
