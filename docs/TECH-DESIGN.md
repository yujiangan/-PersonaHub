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

详见 `src/shared/types.ts`，定义以下跨端类型：

| 类型 | 说明 |
|------|------|
| `GitHubUser` | GitHub 用户基本信息 |
| `GitHubRepo` | 仓库信息 |
| `GitHubEvent` | 用户活动事件 |
| `GitHubStarredRepo` | Starred 仓库 |
| `SSEEvent` | SSE 事件格式 `{ type, content, timestamp }` |

### SSE 事件类型

| type | 触发时机 | content |
|------|----------|---------|
| `thinking` | 每个 Phase 开始时 | 当前阶段的中文描述 |
| `observation` | 每个 Phase 执行成功后 | 该阶段获取到的数据摘要 |
| `final_report` | 报告生成完成后 | Markdown 格式报告全文 |
| `error` | 任意阶段出错时 | 用户可见的中文错误提示 |
| `done` | 流结束前 | 空字符串 |

---

## 4. 系统架构

### 4.1 数据流

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

### 4.2 Agent 阶段定义

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

### 5.1 服务端发送格式

每个事件发送两条 SSE 行：
```
event: <type>
data: <JSON(SSEEvent)>
```

其中 `type` 可为 `thinking` / `observation` / `final_report` / `error` / `done`。

### 5.2 前端接收方式

前端必须使用 `addEventListener` 监听命名事件，不能使用 `onmessage`：

```javascript
eventSource.addEventListener('thinking', (e) => { /* ... */ });
eventSource.addEventListener('observation', (e) => { /* ... */ });
eventSource.addEventListener('final_report', (e) => { /* ... */ });
eventSource.addEventListener('error', (e) => { /* ... */ });
```

详见 `src/app/hooks/useAnalysis.ts`

---

## 6. GitHub API 调用

### 6.1 工具函数

| 函数 | 调用的 GitHub API |
|------|-------------------|
| `getUserProfile` | `GET /users/{username}` |
| `getUserRepos` | `GET /users/{username}/repos` (分页，最多 5 页) |
| `getUserEvents` | `GET /users/{username}/events` (分页，最多 10 页) |
| `getUserStars` | `GET /users/{username}/starred` (分页，最多 10 页) |

详见 `src/server/agent/tools/`

### 6.2 错误处理

| HTTP 状态 | 用户消息 |
|-----------|----------|
| 404 | 用户不存在，请检查 GitHub ID 是否正确。 |
| 403 | API 请求频率超限，请稍后再试。 |
| 408 | 网络异常：请求超时。 |
| 其他 | 网络异常，分析失败，请重试。 |

详见 `src/server/agent/reactor.ts` 中的 `mapErrorToUserMessage` 函数。

---

## 7. 错误分类与响应

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

## 8. 前端组件

| 组件 | 职责 |
|------|------|
| `SearchBar` | 用户输入 GitHub ID，触发分析 |
| `ThinkingStream` | 实时展示 thinking/observation 事件流 |
| `ProfileReport` | 展示最终报告，支持复制 |

详见 `src/app/components/`

---

## 9. 配置文件

| 文件 | 说明 |
|------|------|
| `package.json` | 依赖声明、脚本命令 |
| `vite.config.ts` | Vite 构建配置、API 代理 |
| `nitro.config.ts` | Nitro 服务端配置 |
| `tsconfig.json` | TypeScript 配置 |

---

## 10. 性能与资源

- **分页上限**：单用户最多获取 5000 条事件（10 页 × 100 条）
- **超时控制**：单次 fetch 超时 10s，全流程超时 60s
- **并发控制**：同一 Token 的并发请求受 GitHub 速率限制约束
- **内存管理**：SSE 流式处理不积累大数据

---

## 11. 部署

### 11.1 环境变量

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

**Token 权限要求**：`read:user` + `public_repo`

### 11.2 部署平台

推荐 Vercel（通过 `@vercel/nitro` preset），详见 `nitro.config.ts`。

---

## 12. 实现索引

| 设计点 | 源文件 |
|--------|--------|
| SSE Emitter | `src/server/lib/sse.ts` |
| ReAct 主循环 | `src/server/agent/reactor.ts` |
| 状态调度器 | `src/server/agent/scheduler.ts` |
| 报告生成器 | `src/server/agent/report-builder.ts` |
| GitHubClient | `src/server/agent/tools/github.ts` |
| API 入口 | `src/server/api/analyze.get.ts` |
| 前端 SSE Hook | `src/app/hooks/useAnalysis.ts` |
| 共享类型 | `src/shared/types.ts` |
