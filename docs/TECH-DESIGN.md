# PersonaHub — 技术设计文档

## 1. 概述

### 1.1 项目简介

**项目名称**: PersonaHub
**项目类型**: AI Agent 应用（**规则化 ReAct 循环** + 工具调用 + 状态管理）
**一句话描述**: 输入任意 GitHub 用户 ID，通过分析其公开数据（Profile、Repos、Events、Stars）推断用户偏好、技术栈、活跃时间，生成用户画像情报报告。
**目标用户**: HR / 猎头、安全研究员、普通用户

### 1.2 核心技术理念

本项目的 Agent 不依赖任何 LLM/AI 服务，ReAct 循环的 "Think" 步骤是**规则化的分析逻辑**：

- Agent 根据当前**状态**（已获取哪些数据、还缺什么）决定下一步调用哪个工具
- 最终报告由**结构化数据拼接生成**，纯规则驱动
- 所有数据来源于 **GitHub REST API**，无第三方依赖

---

## 2. 技术选型

| 层级 | 技术选型 |
|------|----------|
| 前端框架 | VitePlus + @vitejs/plugin-react |
| 后端框架 | Nitro（轻量 SSR + API） |
| Agent 实现 | 纯手写 ReAct 循环（Node.js） |
| 数据源 | GitHub REST API（服务端配置 Token） |
| 流式传输 | SSE（Server-Sent Events） |
| 部署目标 | Vercel / Railway / Cloudflare Workers |

### 2.1 技术选型理由

**VitePlus**: 轻量级 Vite 增强，保留 Vite 的极速开发体验
**Nitro**: 极简服务端框架，支持 SSR、API Routes、SSE，开箱即用
**纯手写 ReAct**: 无需 LLM API 成本，响应速度快，完全可控

---

## 3. 系统架构

```
┌─────────────┐      SSE       ┌─────────────┐
│   前端       │  <──────────>  │   Nitro     │
│  (VitePlus) │               │   后端      │
│             │  HTTP POST    │             │
└─────────────┘               └──────┬──────┘
                                      │
                              ┌───────▼───────┐
                              │  ReAct Agent  │
                              │  (手写循环)   │
                              │  状态机驱动   │
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

### 3.1 数据流向

1. 用户在前端输入 GitHub User ID（**无需 Token**）
2. 前端发送 POST 请求到 `/api/analyze`
3. Nitro 后端接收请求，启动 ReAct Agent
4. ReAct Agent 根据状态机调度工具，调用 GitHub API
5. 每一步思考和结果通过 SSE 推送到前端
6. Agent 收集完所有数据后，生成结构化报告
7. 前端展示最终画像报告

---

## 4. 项目结构

```
personahub/
├── src/
│   ├── app/                      # 前端页面
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── index.html
│   │   └── components/
│   │       ├── SearchBar.tsx        # 搜索框组件
│   │       ├── ThinkingStream.tsx   # 思考过程流式展示
│   │       └── ProfileReport.tsx    # 画像报告展示
│   │
│   ├── server/                   # 后端逻辑
│   │   ├── api/
│   │   │   └── analyze.post.ts     # POST /api/analyze
│   │   │
│   │   ├── agent/
│   │   │   ├── index.ts            # Agent 入口
│   │   │   ├── state.ts            # 状态定义
│   │   │   ├── reactor.ts          # ReAct 循环（核心）
│   │   │   ├── report-builder.ts   # 报告生成器
│   │   │   │
│   │   │   └── tools/              # GitHub API 工具
│   │   │       ├── getUserProfile.ts
│   │   │       ├── getUserRepos.ts
│   │   │       ├── getUserEvents.ts
│   │   │       ├── getUserStars.ts
│   │   │       └── getRepoDetails.ts
│   │   │
│   │   └── lib/
│   │       ├── github.ts           # GitHub API 封装
│   │       └── errors.ts           # 错误类型定义
│   │
│   └── shared/                    # 共享类型
│       └── types.ts
│
├── package.json
├── nitro.config.ts
├── vite.config.ts
└── tsconfig.json
```

---

## 5. ReAct Agent 设计（核心）

### 5.1 设计理念

ReAct（Reasoning + Acting）循环的核心是**状态机**：

- Agent 维护一个**状态对象**，记录已获取的数据
- 每一步根据当前状态，**规则化判断**下一步行动
- 不依赖 LLM，所有决策由代码逻辑完成

### 5.2 状态定义

```typescript
// server/agent/state.ts

interface AnalysisState {
  userId: string;
  profile: UserProfile | null;       // 基本信息
  repos: UserRepo[];                 // 仓库列表
  events: UserEvent[];               // 事件 timeline
  stars: StarredRepo[];              // Star 的仓库
  analysisProgress: {
    profileDone: boolean;
    reposDone: boolean;
    eventsDone: boolean;
    starsDone: boolean;
  };
  isDone: boolean;
  error: Error | null;
}

interface UserProfile {
  login: string;
  id: number;
  avatarUrl: string;
  bio: string | null;
  publicRepos: number;
  followers: number;
  following: number;
}

interface UserRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  stargazersCount: number;
  forksCount: number;
  topics: string[];
  createdAt: string;
  updatedAt: string;
}

interface UserEvent {
  id: string;
  type: EventType;
  repo: { name: string; url: string };
  payload: Record<string, any>;
  createdAt: string;
}

interface StarredRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stargazersCount: number;
}
```

### 5.3 ReAct 循环（状态机驱动）

```typescript
// server/agent/reactor.ts

type Action = 'getProfile' | 'getRepos' | 'getEvents' | 'getStars' | 'buildReport' | 'done';

function decideNextAction(state: AnalysisState): Action {
  // 1. 如果还没有获取 profile，优先获取基本信息
  if (!state.profile) {
    return 'getProfile';
  }

  // 2. 如果还没有获取 repos，获取仓库列表
  if (!state.analysisProgress.reposDone) {
    return 'getRepos';
  }

  // 3. 如果还没有获取 events，获取 timeline
  if (!state.analysisProgress.eventsDone) {
    return 'getEvents';
  }

  // 4. 如果还没有获取 stars，获取 Star 列表
  if (!state.analysisProgress.starsDone) {
    return 'getStars';
  }

  // 5. 如果所有数据都获取完成，生成报告
  if (!state.isDone) {
    return 'buildReport';
  }

  return 'done';
}

async function reactor(userId: string, stream: SSEMitter) {
  const state: AnalysisState = {
    userId,
    profile: null,
    repos: [],
    events: [],
    stars: [],
    analysisProgress: {
      profileDone: false,
      reposDone: false,
      eventsDone: false,
      starsDone: false,
    },
    isDone: false,
    error: null,
  };

  while (!state.isDone) {
    const action = decideNextAction(state);

    switch (action) {
      case 'getProfile':
        await stream.push({ type: 'thinking', content: '正在获取用户基本信息...' });
        const profile = await tools.getUserProfile(userId);
        state.profile = profile;
        await stream.push({ type: 'observation', content: `获取成功：${profile.login}` });
        break;

      case 'getRepos':
        await stream.push({ type: 'thinking', content: '正在分析仓库列表...' });
        const repos = await tools.getUserRepos(userId);
        state.repos = repos;
        state.analysisProgress.reposDone = true;
        await stream.push({ type: 'observation', content: `发现 ${repos.length} 个仓库` });
        break;

      case 'getEvents':
        await stream.push({ type: 'thinking', content: '正在分析用户活动记录...' });
        const events = await tools.getUserEvents(userId);
        state.events = events;
        state.analysisProgress.eventsDone = true;
        await stream.push({ type: 'observation', content: `获取 ${events.length} 条活动记录` });
        break;

      case 'getStars':
        await stream.push({ type: 'thinking', content: '正在分析 Star 记录...' });
        const stars = await tools.getUserStars(userId);
        state.stars = stars;
        state.analysisProgress.starsDone = true;
        await stream.push({ type: 'observation', content: `获取 ${stars.length} 个 Star` });
        break;

      case 'buildReport':
        await stream.push({ type: 'thinking', content: '正在生成画像报告...' });
        const report = reportBuilder.build(state);
        state.report = report;
        state.isDone = true;
        await stream.push({ type: 'final_report', content: report });
        break;

      case 'done':
        state.isDone = true;
        break;
    }
  }

  await stream.push({ type: 'done', content: '' });
}
```

### 5.4 工具定义

| 工具名 | 参数 | 返回 | 用途 |
|--------|------|------|------|
| `getUserProfile` | `id: string` | `UserProfile` | 获取用户基本信息 |
| `getUserRepos` | `id: string, page?: number` | `UserRepo[]` | 获取仓库列表（语言、star 等） |
| `getUserEvents` | `id: string, page?: number` | `UserEvent[]` | 获取 timeline 事件 |
| `getUserStars` | `id: string, page?: number` | `StarredRepo[]` | 获取 Star 的仓库 |
| `getRepoDetails` | `owner, repo` | `RepoDetails` | 获取仓库详情（备用） |

### 5.5 思考过程流式输出

每一步 Agent 的思考通过 SSE 推送到前端：

```
event: thinking
data: {"content": "正在获取用户基本信息..."}

event: observation
data: {"content": "获取成功：octocat"}

event: thinking
data: {"content": "正在分析仓库列表..."}

event: observation
data: {"content": "发现 8 个仓库"}

event: final_report
data: {"content": "## 用户画像报告\n\n..."}
```

---

## 6. 报告生成器

### 6.1 报告结构

```typescript
// server/agent/report-builder.ts

interface ProfileReport {
  basicInfo: {
    username: string;
    avatarUrl: string;
    id: number;
    bio: string | null;
    publicRepos: number;
    followers: number;
    following: number;
  };
  techProfile: {
    topLanguages: { name: string; count: number }[];   // Top N 编程语言
    topDomains: { name: string; count: number }[];       // Top N 技术领域
    openSourceStyle: {
      selfBuiltRatio: number;   // 自建仓库占比
      collaborativeRatio: number; // 参与他人项目占比
    };
    preferredTech: string[];    // 偏好技术方向
  };
  activeTime: {
    dayPattern: '工作日' | '周末' | '均衡';
    hourPattern: '白天' | '深夜' | '均衡';
    timezone: string;          // UTC 参考
  };
  recentActivity: {
    mainEventTypes: { type: string; count: number }[];
    topProjects: { name: string; eventCount: number }[];
    techHotspots: string[];    // 近 90 天关注的技术热点
  };
}
```

### 6.2 分析规则（纯代码实现）

#### 编程语言统计
```typescript
function analyzeLanguages(repos: UserRepo[]): LanguageStat[] {
  const langMap = new Map<string, number>();
  for (const repo of repos) {
    if (repo.language) {
      langMap.set(repo.language, (langMap.get(repo.language) || 0) + 1);
    }
  }
  return Array.from(langMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}
```

#### 项目领域推断
```typescript
function analyzeDomains(repos: UserRepo[]): DomainStat[] {
  const keywords: Record<string, string[]> = {
    'AI/ML': ['ai', 'ml', 'machine-learning', 'deep-learning', 'llm', 'gpt', 'transformer', 'torch'],
    'Web': ['web', 'frontend', 'react', 'vue', 'angular', 'http', 'api', 'ui'],
    'DevOps': ['docker', 'kubernetes', 'k8s', 'ci', 'cd', 'deploy', 'terraform', 'ansible'],
    'Infrastructure': ['server', 'cloud', 'aws', 'gcp', 'azure', 'infra', 'config'],
    'Tooling': ['cli', 'tool', 'utility', 'script', 'automation'],
  };

  const domainMap = new Map<string, number>();
  for (const repo of repos) {
    const text = `${repo.name} ${repo.description || ''} ${repo.topics.join(' ')}`.toLowerCase();
    for (const [domain, words] of Object.entries(keywords)) {
      if (words.some(w => text.includes(w))) {
        domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
      }
    }
  }
  // ... 类似语言统计的排序返回
}
```

#### 活跃时间分析
```typescript
function analyzeActiveTime(events: UserEvent[]): ActiveTimePattern {
  const hourCount = new Array(24).fill(0);
  const dayCount = { weekday: 0, weekend: 0 };

  for (const event of events) {
    const date = new Date(event.createdAt);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    hourCount[hour]++;
    if (day === 0 || day === 6) dayCount.weekend++;
    else dayCount.weekday++;
  }

  const peakHour = hourCount.indexOf(Math.max(...hourCount));
  const isWeekendHeavy = dayCount.weekend > dayCount.weekday * 0.4;

  return {
    hourPattern: peakHour >= 22 || peakHour <= 6 ? '深夜' : '白天',
    dayPattern: isWeekendHeavy ? '周末' : '工作日',
    timezone: 'UTC',
  };
}
```

---

## 7. GitHub API 封装

### 7.1 请求封装

```typescript
// server/lib/github.ts

const GITHUB_API_BASE = 'https://api.github.com';

interface GitHubConfig {
  token: string;
}

export async function githubFetch<T>(
  endpoint: string,
  config: GitHubConfig
): Promise<T> {
  const url = `${GITHUB_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'PersonaHub',
    },
  });

  if (!response.ok) {
    throw new GitHubError(response.status, await response.text());
  }

  return response.json();
}
```

### 7.2 错误处理

```typescript
// server/lib/errors.ts

export class GitHubError extends Error {
  constructor(
    public status: number,
    public message: string
  ) {
    super(message);
  }
}

export const ERROR_MESSAGES: Record<number, string> = {
  301: '用户已迁移',
  404: '未找到该 GitHub 用户，请检查 ID 是否正确',
  403: 'API 配额已用尽，请稍后再试',
  500: 'GitHub API 服务异常',
  503: 'GitHub API 服务暂不可用',
};
```

---

## 8. API 设计

### 8.1 端点

**POST /api/analyze**

请求：
```json
{
  "githubId": "octocat"
}
```

> GitHub Token 在服务端环境变量配置，无需用户输入

响应（SSE 事件流）：
```
event: thinking
data: {"content": "正在获取用户基本信息..."}

event: observation
data: {"content": "获取成功：octocat"}

event: thinking
data: {"content": "正在分析仓库列表..."}

event: observation
data: {"content": "发现 8 个仓库"}

event: thinking
data: {"content": "正在分析用户活动记录..."}

event: observation
data: {"content": "获取 30 条活动记录"}

event: thinking
data: {"content": "正在分析 Star 记录..."}

event: observation
data: {"content": "获取 15 个 Star"}

event: thinking
data: {"content": "正在生成画像报告..."}

event: final_report
data: {"content": "## 用户画像报告\n\n### 基本信息\n..."}

event: done
data: {}
```

### 8.2 错误响应

```
event: error
data: {"content": "未找到该 GitHub 用户，请检查 ID 是否正确"}
```

### 8.3 异常与边界情况

| 场景 | 产品表现 |
|------|----------|
| 用户不存在 | SSE error: "未找到该 GitHub 用户，请检查 ID 是否正确" |
| 公开数据不足 | 各模块独立分析，能分析多少展示多少，无数据标注"无公开数据" |
| 网络异常 | SSE error: "网络异常，分析失败，请重试" |
| 分析超时 | SSE error: "分析超时，请重试" |
| API 配额用尽 | SSE error: "服务繁忙，请稍后再试" |

---

## 9. 前端设计

### 9.1 组件结构

```
src/app/components/
├── SearchBar.tsx       # GitHub ID 输入框 + 开始分析按钮
├── ThinkingStream.tsx  # 实时流式展示 Agent 思考过程
└── ProfileReport.tsx   # 画像报告展示（四个模块卡片）
```

### 9.2 组件说明

**SearchBar**
- 输入框：GitHub User ID
- 按钮：开始分析（loading 状态）
- 状态：idle / loading / error

**ThinkingStream**
- 实时显示 Agent 思考过程
- 分类展示：thinking / observation
- 每个条目带图标和时间戳
- 自动滚动到底部

**ProfileReport**
- 展示最终生成的画像报告
- 四个模块卡片：基本信息、技术画像、活跃时间、最近动态
- 支持复制报告内容

---

## 10. 环境变量

```bash
# .env
NITRO_PORT=3000
GITHUB_TOKEN=ghp_xxxx  # GitHub Personal Access Token，服务端使用
```

---

## 11. 实现计划

| Phase | 内容 | 交付物 |
|-------|------|--------|
| 1 | 项目初始化 | VitePlus + React + Nitro 项目，TypeScript 配置 |
| 2 | GitHub API 封装 | 5 个工具函数，错误处理 |
| 3 | ReAct Agent 核心 | 状态机、ReAct 循环、流式输出 |
| 4 | 报告生成器 | 结构化报告拼接（语言/领域/时间/热点分析） |
| 5 | 后端 API | POST /api/analyze 端点 |
| 6 | 前端界面 | SearchBar、ThinkingStream、ProfileReport |
| 7 | 联调与边界处理 | 完整流程测试、异常场景处理 |
| 8 | 部署 | Vercel / Railway / Cloudflare |

---

## 12. 验收标准

### 12.1 功能验收

- [ ] 输入任意有效 GitHub 用户 ID，能返回画像报告
- [ ] 报告包含"基本信息、技术画像、活跃时间、最近动态"四个模块
- [ ] 输入不存在用户 ID，给出明确提示
- [ ] 网络异常时，给出"网络异常，分析失败，请重试"提示
- [ ] 分析超时，给出"分析超时，请重试"提示
- [ ] API 配额用尽时，给出"服务繁忙，请稍后再试"提示
- [ ] 分析过程在界面上实时展示

### 12.2 体验验收

- [ ] 分析过程有合理超时保护
- [ ] 界面在分析过程中无卡顿
- [ ] 错误提示清晰，用户知道如何解决

### 12.3 边界情况验收

- [ ] 用户存在但公开数据不足时，各模块独立分析，能分析多少展示多少
- [ ] API 限流时优雅报错，不出现崩溃
- [ ] 重复提交分析请求时正确处理

---

## 13. 参考文档

- [VitePlus 文档](https://viteplus.dev/guide/)
- [Nitro 文档](https://nitro.unjs.io/)
- [GitHub REST API](https://docs.github.com/en/rest)
