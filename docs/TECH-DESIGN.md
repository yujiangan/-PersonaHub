# PersonaHub — 技术设计文档

## 1. 技术栈

| 层级 | 技术选型 |
|------|----------|
| 前端 | VitePlus + React + TypeScript |
| 后端 | Nitro（SSR + API） |
| Agent | 纯手写 ReAct 循环（Node.js） |
| 数据源 | GitHub API（公开数据，需用户输入 Token） |
| 流式输出 | SSE（Server-Sent Events） |
| 部署目标 | Vercel / Railway / Cloudflare Workers |

---

## 2. 系统架构

```
┌─────────────┐      SSE       ┌─────────────┐
│   前端       │  <──────────>  │   Nitro     │
│  (VitePlus) │               │   后端      │
│             │   HTTP POST   │             │
└─────────────┘               └──────┬──────┘
                                      │
                              ┌───────▼───────┐
                              │  ReAct Agent  │
                              │  (手写循环)   │
                              └───────┬───────┘
                                      │
                        ┌─────────────┼─────────────┐
                        │             │             │
                  ┌─────▼─────┐ ┌─────▼─────┐ ┌────▼────┐
                  │ getUser   │ │ getUser   │ │ getUser │
                  │ Profile   │ │ Events    │ │ Stars   │
                  └───────────┘ └───────────┘ └─────────┘
                                      │
                              ┌───────▼───────┐
                              │  GitHub API   │
                              └───────────────┘
```

---

## 3. 项目结构

```
personahub/
├── src/
│   ├── app/
│   │   └── (frontend)           # 前端页面
│   │       ├── App.tsx
│   │       ├── components/
│   │       │   ├── SearchBar.tsx
│   │       │   ├── ThinkingStream.tsx
│   │       │   └── ProfileReport.tsx
│   │       └── api/
│   ├── server/
│   │   ├── api/
│   │   │   └── analyze.post.ts  # POST /api/analyze
│   │   ├── agent/
│   │   │   ├── index.ts         # ReAct 循环入口
│   │   │   ├── react.ts         # ReAct 逻辑
│   │   │   ├── prompt.ts        # Prompt 模板
│   │   │   └── tools/
│   │   │       ├── getUserProfile.ts
│   │   │       ├── getUserRepos.ts
│   │   │       ├── getUserEvents.ts
│   │   │       ├── getUserStars.ts
│   │   │       └── getRepoDetails.ts
│   │   └── lib/
│   │       └── github.ts        # GitHub API 封装
├── package.json
├── nitro.config.ts
└── tsconfig.json
```

---

## 4. ReAct Agent 设计

### 4.1 Agent 循环

```typescript
while (not done) {
    // 1. Think: 分析当前状态，决定下一步
    const thought = await agent.think(context);

    // 2. Action: 选择并调用工具
    const result = await agent.act(thought, context);

    // 3. Observe: 获取结果
    context.history.push({ thought, action: result });

    // 4. Stream: 推送思考过程到前端
    await stream.push({ type: 'thinking', content: thought });
    await stream.push({ type: 'action', content: result.action });
    await stream.push({ type: 'observation', content: result.observation });

    // 5. 判断是否完成
    if (agent.isDone(context)) {
        break;
    }
}
```

### 4.2 Prompt 模板

System Prompt：

```
你是一个 OSINT（开源情报）分析师，擅长通过 GitHub 公开数据分析人物的技术背景和兴趣。

你的任务是分析给定的 GitHub 用户，生成一份用户画像情报报告。

分析维度：
1. 基本信息（用户名、头像、ID、bio）
2. 技术领域（通过仓库和事件分析）
3. 活跃时间（timeline 分析）
4. 喜欢的技术 Top N（通过 stars + repos 分析）
5. 最近在做什么（通过 events 推断）

输出格式为结构化报告，语言简洁专业。
```

### 4.3 工具定义

| 工具名 | 参数 | 返回 | 用途 |
|--------|------|------|------|
| `getUserProfile` | `id: string` | 用户基本信息 | 第一步获取 |
| `getUserRepos` | `id: string` | 仓库列表（语言、star 数等） | 分析技术栈 |
| `getUserEvents` | `id: string` | timeline 事件 | 分析活跃时间、近期行为 |
| `getUserStars` | `id: string` | star 的仓库列表 | 分析偏好技术 |
| `getRepoDetails` | `owner, repo` | 仓库详情 | 深入分析某个仓库 |

---

## 5. GitHub API 封装

### 5.1 请求封装

```typescript
// server/lib/github.ts

interface GitHubConfig {
  token: string;
  baseUrl: 'https://api.github.com';
}

export async function githubFetch(
  endpoint: string,
  config: GitHubConfig
): Promise<any> {
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'PersonaHub'
    }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new GitHubError(response.status, error.message);
  }

  return response.json();
}
```

### 5.2 错误类型

```typescript
class GitHubError extends Error {
  constructor(
    public status: number,
    public message: string
  ) {
    super(message);
  }
}

// 状态码映射
const ERROR_MESSAGES: Record<number, string> = {
  401: 'GitHub Token 无效',
  403: 'API 配额已用尽，或 Token 权限不足',
  404: '用户不存在',
  500: 'GitHub API 服务异常',
};
```

---

## 6. API 设计

### 6.1 端点

**POST /api/analyze**

请求：
```json
{
  "githubId": "octocat"
}
```

> GitHub Token 在服务端配置，不暴露给用户

响应（SSE 事件流：

```
event: thinking
data: {"content": "正在获取用户基本信息..."}

event: action
data: {"content": "调用 getUserProfile"}

event: observation
data: {"content": "获取成功，用户名: octocat"}

event: thinking
data: {"content": "现在分析用户的技术栈..."}

event: action
data: {"content": "调用 getUserRepos"}

...

event: final_report
data: {"content": "## 用户画像报告\n\n..."}

event: done
data: {}
```

### 6.2 错误响应

```
event: error
data: {"content": "用户不存在"}
```

---

## 7. 前端组件设计

### 7.1 SearchBar

- 输入框：GitHub User ID
- 按钮：开始分析
- 状态：idle / loading / error

### 7.2 ThinkingStream

- 实时显示 Agent 思考过程
- 分类展示：thought / action / observation
- 每个条目带图标和时间戳
- 自动滚动到底部

### 7.3 ProfileReport

- 展示最终生成的画像报告
- 五个模块卡片：基本信息、技术领域、活跃时间、偏好技术、最近动态
- 支持复制报告内容

---

## 8. 实现计划

| Phase | 内容 | 交付物 |
|-------|------|--------|
| 1 | 项目初始化 | VitePlus + React + Nitro 项目，TypeScript 配置 |
| 2 | GitHub API 封装 | 5 个工具函数，错误处理 |
| 3 | ReAct Agent 核心 | Agent 循环、Prompt 模板、流式输出 |
| 4 | 后端 API | POST /api/analyze 端点 |
| 5 | 前端界面 | SearchBar、ThinkingStream、ProfileReport |
| 6 | 联调与边界处理 | 完整流程测试、异常场景处理 |
| 7 | 部署 | Vercel / Railway / Cloudflare |

---

## 9. 部署配置

### 9.1 环境变量

```
# .env
NITRO_PORT=3000
GITHUB_TOKEN=ghp_xxxx  # GitHub Personal Access Token，服务端使用
```

### 9.2 Vercel 配置

```json
// vercel.json
{
  "builds": [
    { "src": "package.json", "use": "@vercel/nft" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/analyze" }
  ]
}
```
