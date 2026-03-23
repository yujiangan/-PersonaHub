# PersonaHub — 技术设计文档

> 本文档面向开发者，定义系统架构、模块边界、接口契约与实现细节。
> 代码实现详见对应源文件，文档只引用路径不做内联。

---

## 1. 技术选型

| 层级 | 技术 | 版本要求 | 用途 |
|------|------|----------|------|
| 构建工具 | VitePlus | ^3.x | 前端开发服务器与构建 |
| React 插件 | @vitejs/plugin-react | ^4.x | React 17+ JSX Transform |
| 服务端框架 | Nitro | ^3.x | API Routes、SSR、SSE |
| 语言 | TypeScript | ^5.x | 全栈类型安全 |
| 流式协议 | Server-Sent Events | — | 服务端→客户端实时推送 |

### 1.1 技术选型理由

- **VitePlus**: 基于 Vite 的轻量增强，保留 Vite 原生 DX，plugin-react 兼容 React 生态。
- **Nitro**: 极简服务端框架，支持任意运行时（Node.js / Cloudflare Workers / Vercel），API 设计与 H3 兼容。
- **纯手写 ReAct**: 无 LLM 依赖，决策逻辑完全由代码控制，零推理成本。

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
│   │   │   ├── ThinkingStream.tsx
│   │   │   └── ProfileReport.tsx
│   │   └── hooks/
│   │       └── useAnalysis.ts      # SSE 客户端 Hook
│   │
│   ├── server/                      # Nitro 服务端
│   │   ├── api/
│   │   │   └── analyze.get.ts      # GET /api/analyze
│   │   ├── agent/
│   │   │   ├── index.ts            # Agent Facade
│   │   │   ├── types.ts            # Agent 内部类型
│   │   │   ├── reactor.ts          # ReAct 主循环
│   │   │   ├── scheduler.ts        # 状态转移决策
│   │   │   ├── report-builder.ts   # 报告生成
│   │   │   └── tools/
│   │   │       ├── github.ts       # GitHubClient
│   │   │       ├── get-profile.ts
│   │   │       ├── get-repos.ts
│   │   │       ├── get-events.ts
│   │   │       └── get-stars.ts
│   │   └── lib/
│   │       ├── sse.ts              # SSE Emitter
│   │       └── errors.ts
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
  login: string;
  id: number;
  avatarUrl: string;
  bio: string | null;
  publicRepos: number;
  followers: number;
  following: number;
  createdAt: string;  // ISO 8601
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
  createdAt: string;  // ISO 8601，用于 90 天过滤
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

```typescript
// SSEEvent — 统一事件格式
// timestamp 为 Unix 毫秒时间戳（Date.now()），前端用 new Date(timestamp) 转换
interface SSEEvent {
  type: 'thinking' | 'observation' | 'final_report' | 'error' | 'done';
  content: string;
  timestamp: number;  // Unix ms
}
```

| type | 触发时机 | content 示例 |
|------|----------|-------------|
| `thinking` | 每个 Phase 开始时 | "正在获取用户资料..." |
| `observation` | 每个 Phase 执行成功后 | 见下方摘要结构 |
| `final_report` | 报告生成完成后 | Markdown 报告全文 |
| `error` | 任意阶段出错时 | 用户可见的中文错误提示 |
| `done` | 流结束前 | 空字符串 |

**observation content 摘要结构**（`formatObservation`）：

| Phase | content 示例 |
|-------|-------------|
| FETCHING_PROFILE | "已加载用户资料：{login}" 或 "无用户资料数据" |
| FETCHING_REPOS | "已获取 {n} 个仓库"（n=0 时仍发送） |
| FETCHING_EVENTS | "已获取 {n} 条事件"（n=0 时仍发送） |
| FETCHING_STARS | "已获取 {n} 个 Starred 仓库"（n=0 时仍发送） |

注：数据为空（如 repos=[]）属于「调用成功」，仍发送 observation；「调用失败」才发送 error。

### 3.3 Agent 核心类型

```typescript
// Phase — Agent 执行阶段
type Phase =
  | 'INIT'
  | 'FETCHING_PROFILE'
  | 'FETCHING_REPOS'
  | 'FETCHING_EVENTS'
  | 'FETCHING_STARS'
  | 'BUILDING_REPORT'
  | 'DONE'
  | 'ERROR';

// AnalysisContext — ReAct 主循环上下文，各 Phase 间传递数据
interface AnalysisContext {
  userId: string;
  phase: Phase;
  profile: GitHubUser | null;          // 无数据时为 null，不中断
  repos: GitHubRepo[];                  // 无数据时为 []
  events: GitHubEvent[];                // 无数据时为 []
  stars: GitHubStarredRepo[];           // 无数据时为 []
  error: GitHubError | null;            // 当前模块错误，不中断后续模块
  startedAt: number;                    // Unix ms，用于超时检测
}

// SchedulerOutput — Scheduler 返回值
interface SchedulerOutput {
  nextPhase: Phase;
  execute: () => Promise<void>;         // 异步执行函数
}

// GitHubError — GitHub API 错误
class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string
  ) { super(message); }
}
```

---

## 4. 系统架构

### 4.1 ReAct 主循环（伪代码）

```typescript
while (phase !== 'DONE' && phase !== 'ERROR') {
  emitter.emit('thinking', PHASE_MESSAGES[phase]);

  if (phase === 'BUILDING_REPORT') {
    emitter.emit('final_report', buildReport(ctx));
    emitter.emit('done', '');
    break;
  }

  const { nextPhase, execute } = schedule(ctx, client);

  try {
    await execute();
    phase = nextPhase;
    emitter.emit('observation', formatObservation(ctx));
  } catch (err) {
    ctx.error = err as GitHubError;                    // 记录错误，但不中断
    emitter.emit('error', mapErrorToUserMessage(err as Error)); // 降级继续
  }
}
```

**关键设计**：
- 任一模块失败只记录 `ctx.error`，后续模块继续执行（降级策略）
- `final_report` 后发送 `done` 事件形成闭环
- 详见 `src/server/agent/reactor.ts`

### 4.2 数据流

```
用户输入 GitHub ID
        │
        ▼
┌───────────────────┐
│   /api/analyze    │  ← Nitro API Route
│   (analyze.get.ts)│
└─────────┬─────────┘
          │ 创建 SSE Stream
          ▼
┌───────────────────┐
│   runReactor()    │  ← ReAct 主循环 (reactor.ts)
│                   │
│  ┌─────────────┐  │
│  │  Scheduler  │  │  ← 状态转移决策 (scheduler.ts)
│  └──────┬──────┘  │
│         │ schedule()
│         ▼         │
│  ┌─────────────────────────────┐
│  │  Tools: get-profile/repos/  │
│  │  events/stars (GitHub API)  │
│  └─────────────┬───────────────┘
│                │ 数据收集完毕
│                ▼
│  ┌───────────────────────┐
│  │   report-builder.ts   │  ← 报告生成
│  └───────────┬───────────┘
│              │ final_report
└──────────────┼──────────────┘
               ▼
        SSE 推送到前端
```

### 4.3 报告维度（对齐 PRD）

报告须包含以下四个模块，详见 `src/server/agent/report-builder.ts`：

| 维度 | 说明 | 数据来源 |
|------|------|----------|
| 技术画像 | 编程语言 Top N、项目领域、开源风格（自建/协作比例）、偏好技术 | repos + stars |
| 活跃时间 | 活跃时段（工作日/周末/均衡）、高峰小时（UTC） | events |
| 最近动态 | 90 天内活动数、事件类型分布、活跃项目、技术热点 | events（created_at >= 90 天前） |
| 基本信息 | 用户名、头像、Bio、粉丝数、仓库数等 | profile |

**90 天时间范围**：在 `analyzeRecentActivity` 中以 `Date.now() - 90 * 24 * 60 * 60 * 1000` 为截止时间过滤 events。

**「无公开数据」处理**：任一维度数据为空时（如 events=[]），该维度在报告中标注"无公开数据"，不显示为空或报错。

**编程语言 Top N**：统计所有 repos 中 `language` 字段的出现频率，按降序取前 5，百分比 = 该语言仓库数 / 有语言标注的仓库总数。

**开源风格计算**：
- 自建仓库 = `fork === false` 的仓库数
- 协作仓库 = `fork === true` 的仓库数
- 自建比例 = 自建仓库数 / 总仓库数（百分比）

> **口径说明**：本期使用 `fork` 字段做近似估算，fork === true 仅表示该仓库是从他人项目复制而来，不严格识别真实协作行为（如 fork 后有提交记录或加入了 Organization）。

详见 `src/server/agent/report-builder.ts` 中的 `analyzeLanguages` / `analyzeOpenSourceStyle`。

### 4.4 Scheduler（伪代码）

```typescript
function schedule(ctx: AnalysisContext, client: GitHubClient): SchedulerOutput {
  switch (ctx.phase) {
    case 'INIT':
      return { nextPhase: 'FETCHING_PROFILE', execute: () => { ctx.profile = await getUserProfile(client, ctx.userId); } };
    case 'FETCHING_PROFILE':
      return { nextPhase: 'FETCHING_REPOS', execute: () => { ctx.repos = await getUserRepos(client, ctx.userId); } };
    case 'FETCHING_REPOS':
      return { nextPhase: 'FETCHING_EVENTS', execute: () => { ctx.events = await getUserEvents(client, ctx.userId); } };
    case 'FETCHING_EVENTS':
      return { nextPhase: 'FETCHING_STARS', execute: () => { ctx.stars = await getUserStars(client, ctx.userId); } };
    case 'FETCHING_STARS':
      return { nextPhase: 'BUILDING_REPORT', execute: () => {} }; // 报告构建在 reactor 中调用
  }
}
```

状态转移固定顺序，详见 `src/server/agent/scheduler.ts`。

### 4.5 Agent 阶段定义

| Phase | 说明 | 出错策略 |
|-------|------|----------|
| `INIT` | 初始化 | — |
| `FETCHING_PROFILE` | 获取用户资料 | 降级：profile 为 null 仍继续 |
| `FETCHING_REPOS` | 获取仓库列表 | 降级：repos 为空数组仍继续 |
| `FETCHING_EVENTS` | 获取活动时间线 | 降级：events 为空数组仍继续 |
| `FETCHING_STARS` | 获取 Starred 仓库 | 降级：stars 为空数组仍继续 |
| `BUILDING_REPORT` | 生成报告 | — |
| `DONE` | 完成 | — |
| `ERROR` | 出错 | — |

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

### 5.2 thinking 阶段描述（对齐 PRD 用户可感知进度）

thinking 事件发送的是用户可感知的进度描述，应与 PRD 中的阶段对应：

| Phase | thinking content（中文） |
|-------|------------------------|
| INIT | "正在初始化分析..." |
| FETCHING_PROFILE | "正在获取基本信息..." |
| FETCHING_REPOS | "正在分析仓库列表..." |
| FETCHING_EVENTS | "正在分析活跃时间..." |
| FETCHING_STARS | "正在分析 Star 记录..." |
| BUILDING_REPORT | "正在生成分析报告..." |

详见 `src/server/agent/reactor.ts` 中的 `PHASE_MESSAGES`。

### 5.3 前端接收方式

前端必须使用 `addEventListener` 监听命名事件，不能使用 `onmessage`：

```javascript
eventSource.addEventListener('thinking', (e) => { /* ... */ });
eventSource.addEventListener('observation', (e) => { /* ... */ });
eventSource.addEventListener('final_report', (e) => { /* ... */ });
eventSource.addEventListener('error', (e) => { /* ... */ });
```

详见 `src/app/hooks/useAnalysis.ts`

---

## 6. 错误处理（伪代码）

```typescript
function mapErrorToUserMessage(err: Error): string {
  if (err instanceof GitHubError) {
    switch (err.status) {
      case 404: return '用户不存在，请检查 GitHub ID 是否正确。';
      case 403: return 'API 请求频率超限，请稍后再试。';
      default:  return `网络异常：${err.message}`;
    }
  }
  return '网络异常，分析失败，请重试。';
}
```

详见 `src/server/agent/reactor.ts`。

---

## 7. GitHub API 调用

### 7.1 工具函数

| 函数 | 调用的 GitHub API | 分页规则 |
|------|-------------------|----------|
| `getUserProfile` | `GET /users/{username}` | — |
| `getUserRepos` | `GET /users/{username}/repos` | `per_page=100`，最多 5 页（500 条） |
| `getUserEvents` | `GET /users/{username}/events` | `per_page=100`，最多 10 页（1000 条） |
| `getUserStars` | `GET /users/{username}/starred` | `per_page=100`，最多 10 页（1000 条） |

**分页终止条件**：遇空页即停止（非强制拉满最大页数）。

**字段筛选**：各工具函数只取需要的字段，其余丢弃，减少内存占用。

**分页逻辑**（伪代码）：

```typescript
async function fetchAllPages(client, baseEndpoint, maxPages = 5, perPage = 100) {
  const results = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await client.fetch(`${baseEndpoint}?per_page=${perPage}&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;  // 遇空页停止
    results.push(...data);
    if (data.length < perPage) break;  // 不足一页说明已到末尾
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

| 403 场景 | 判断方式 | 用户消息 |
|----------|----------|----------|
| 单用户请求频率超限 | 单用户短时间内大量请求 | API 请求频率超限，请稍后再试。 |
| Token 配额用尽 | X-RateLimit-Remaining = 0 | 服务繁忙，请稍后再试。 |

判断逻辑：响应头中 `X-RateLimit-Remaining === 0` 时视为配额用尽，否则视为单用户限流。

**「数据为空」与「调用失败」的区别**：

| 场景 | 触发条件 | observation content 示例 | 是否发送 error |
|------|----------|-------------------------|----------------|
| 调用成功，数据为空 | API 返回 200 但 body=[] | "已获取 0 个仓库" | 否 |
| 调用失败 | API 返回 404/403/网络错误 | — | 是（发送 error，降级继续） |

详见 `src/server/agent/reactor.ts` 中的 `mapErrorToUserMessage` 函数。

---

## 8. 错误分类与响应

| 错误类型 | 触发条件 | 用户消息 | HTTP 状态码 |
|----------|----------|----------|-------------|
| 无效输入 | githubId 格式不符 | GitHub ID 格式不正确 | 400 |
| 用户不存在 | GitHub API 404 | 用户不存在，请检查 GitHub ID 是否正确。 | — (SSE) |
| API 限流 | GitHub API 403 | API 请求频率超限，请稍后再试。 | — (SSE) |
| 请求超时 | 超过 60s | 分析超时，请重试。 | — (SSE) |
| 网络错误 | fetch 抛出异常 | 网络异常，分析失败，请重试。 | — (SSE) |
| 服务繁忙 | 未捕获异常 | 服务繁忙，请稍后再试。 | — (SSE) |
| 配置错误 | 缺少 GITHUB_TOKEN | (不返回给客户端) | 500 |

---

## 9. 前端组件

| 组件 | 职责 |
|------|------|
| `SearchBar` | 用户输入 GitHub ID，触发分析 |
| `ThinkingStream` | 实时展示 thinking/observation 事件流 |
| `ProfileReport` | 展示最终报告，支持复制 |

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
```

**Token 权限要求**：`read:user` + `public_repo`

### 12.2 部署平台

推荐 Vercel（通过 `@vercel/nitro` preset），详见 `nitro.config.ts`。

---

## 13. 实现索引

| 设计点 | 源文件 | 关键导出 |
|--------|--------|----------|
| SSE Emitter | `src/server/lib/sse.ts` | `SSEEmitter.emit()`, `createSSEStream()` |
| ReAct 主循环 | `src/server/agent/reactor.ts` | `runReactor()` |
| 状态调度器 | `src/server/agent/scheduler.ts` | `schedule()` |
| 报告生成器 | `src/server/agent/report-builder.ts` | `buildReport()`, `analyzeLanguages()`, `analyzeOpenSourceStyle()`, `analyzeActiveTime()`, `analyzeRecentActivity()` |
| GitHubClient | `src/server/agent/tools/github.ts` | `GitHubClient.fetch()`, `fetchAllPages()` |
| API 入口 | `src/server/api/analyze.get.ts` | — |
| 前端 SSE Hook | `src/app/hooks/useAnalysis.ts` | `useAnalysis()` |
| 共享类型 | `src/shared/types.ts` | `GitHubUser`, `GitHubRepo`, `GitHubEvent`, `SSEEvent`, `Phase`, `AnalysisContext` |
