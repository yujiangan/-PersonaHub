# PersonaHub — 技术设计文档

> 本文档面向开发者，定义系统架构、模块边界、接口契约与实现细节。

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

**VitePlus**: 基于 Vite 的轻量增强，保留 Vite 原生 DX，plugin-react 兼容 React 生态。
**Nitro**: 极简服务端框架，支持任意运行时（Node.js / Cloudflare Workers / Vercel），API 设计与 H3 兼容。
**纯手写 ReAct**: 无 LLM 依赖，决策逻辑完全由代码控制，零推理成本。

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
│   │       └── useAnalysis.ts      # SSE 客户端 hooks
│   │
│   ├── server/                      # Nitro 服务端
│   │   ├── api/
│   │   │   └── analyze.post.ts     # POST /api/analyze
│   │   │
│   │   ├── agent/
│   │   │   ├── index.ts            # Agent Facade（导出 runAgent）
│   │   │   ├── types.ts            # Agent 内部类型
│   │   │   ├── reactor.ts         # ReAct 主循环
│   │   │   ├── scheduler.ts       # 状态转移决策
│   │   │   ├── report-builder.ts   # 报告生成
│   │   │   └── tools/
│   │   │       ├── github.ts      # GitHubClient 类
│   │   │       ├── get-profile.ts
│   │   │       ├── get-repos.ts
│   │   │       ├── get-events.ts
│   │   │       └── get-stars.ts
│   │   │
│   │   └── lib/
│   │       ├── sse.ts              # SSE Emitter
│   │       └── errors.ts           # 错误类型
│   │
│   └── shared/
│       └── types.ts                # 跨端类型（interface only）
│
├── package.json
├── nitro.config.ts
├── vite.config.ts
└── tsconfig.json
```

---

## 3. 共享类型定义

```typescript
// shared/types.ts

export interface GitHubUser {
  login: string;
  id: number;
  avatarUrl: string;
  bio: string | null;
  publicRepos: number;
  followers: number;
  following: number;
  createdAt: string;
}

export interface GitHubRepo {
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

export type GitHubEventType =
  | 'PushEvent'
  | 'CreateEvent'
  | 'ForkEvent'
  | 'WatchEvent'
  | 'IssuesEvent'
  | 'PullRequestEvent'
  | 'IssueCommentEvent'
  | 'PullRequestReviewEvent'
  | 'ReleaseEvent';

export interface GitHubEvent {
  id: string;
  type: GitHubEventType;
  repo: { name: string; url: string };
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GitHubStarredRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stargazersCount: number;
}

export interface SSEEvent {
  type: 'thinking' | 'observation' | 'final_report' | 'error' | 'done';
  content: string;
  timestamp: number;
}
```

---

## 4. GitHub API 客户端

### 4.1 客户端封装

```typescript
// server/agent/tools/github.ts

const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class GitHubClient {
  constructor(private readonly token: string) {}

  async fetch<T>(endpoint: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.doFetch<T>(endpoint);
      } catch (err) {
        lastError = err as Error;

        if (!this.isRetryable(err as GitHubError)) {
          throw err;
        }

        if (attempt < MAX_RETRIES) {
          await this.delay(this.backoffMs(attempt));
        }
      }
    }

    throw lastError ?? new Error('Unexpected fetch failure');
  }

  private async doFetch<T>(endpoint: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const url = `${GITHUB_API_BASE}${endpoint}`;
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'PersonaHub/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw this.statusToError(res.status, endpoint);
      }

      // GitHub API can return 204 No Content for some endpoints
      if (res.status === 204) {
        return [] as T;
      }

      return res.json() as Promise<T>;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new GitHubError(408, endpoint, 'Request timeout');
      }

      throw err;
    }
  }

  private statusToError(status: number, endpoint: string): GitHubError {
    const messages: Record<number, string> = {
      301: 'User has moved permanently',
      404: 'Resource not found',
      403: 'API rate limit exceeded or insufficient permissions',
      500: 'GitHub API internal error',
      502: 'Bad gateway',
      503: 'GitHub API unavailable',
    };

    return new GitHubError(
      status,
      endpoint,
      messages[status] ?? `GitHub API error: ${status}`
    );
  }

  private isRetryable(err: GitHubError): boolean {
    // 403 can be rate limit or permissions - treat as retryable
    return [403, 500, 502, 503].includes(err.status);
  }

  private backoffMs(attempt: number): number {
    // Exponential backoff: 500ms, 2000ms
    return 500 * Math.pow(2, attempt);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 4.2 分页工具

```typescript
// server/agent/tools/github.ts

export interface PaginatedResult<T> {
  data: T[];
  total: number;
}

export async function fetchAllPages<T>(
  client: GitHubClient,
  baseEndpoint: string,
  options: {
    maxPages?: number;      // default 5
    itemsPerPage?: number;  // default 100
  } = {}
): Promise<T[]> {
  const { maxPages = 5, itemsPerPage = 100 } = options;
  const results: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const endpoint = `${baseEndpoint}?per_page=${itemsPerPage}&page=${page}`;
    const data = await client.fetch<T[]>(endpoint);

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    results.push(...data);

    if (data.length < itemsPerPage) {
      break;
    }
  }

  return results;
}
```

### 4.3 工具函数

```typescript
// server/agent/tools/get-profile.ts

import { GitHubClient } from './github';
import type { GitHubUser } from '../../../shared/types';

export async function getUserProfile(
  client: GitHubClient,
  userId: string
): Promise<GitHubUser> {
  const data = await client.fetch<Record<string, unknown>>(`/users/${userId}`);

  return {
    login: String(data.login),
    id: Number(data.id),
    avatarUrl: String(data.avatar_url),
    bio: data.bio as string | null,
    publicRepos: Number(data.public_repos),
    followers: Number(data.followers),
    following: Number(data.following),
    createdAt: String(data.created_at),
  };
}
```

```typescript
// server/agent/tools/get-repos.ts

import { GitHubClient, fetchAllPages } from './github';
import type { GitHubRepo } from '../../../shared/types';

export async function getUserRepos(
  client: GitHubClient,
  userId: string
): Promise<GitHubRepo[]> {
  const repos = await fetchAllPages<Record<string, unknown>>(client, `/users/${userId}/repos`, {
    maxPages: 5,
    itemsPerPage: 100,
  });

  return repos.map(r => ({
    id: Number(r.id),
    name: String(r.name),
    fullName: String(r.full_name),
    description: (r.description as string) || null,
    language: (r.language as string) || null,
    stargazersCount: Number(r.stargazers_count),
    forksCount: Number(r.forks_count),
    topics: Array.isArray(r.topics) ? r.topics.map(String) : [],
    fork: Boolean(r.fork),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}
```

```typescript
// server/agent/tools/get-events.ts

import { GitHubClient, fetchAllPages } from './github';
import type { GitHubEvent, GitHubEventType } from '../../../shared/types';

export async function getUserEvents(
  client: GitHubClient,
  userId: string
): Promise<GitHubEvent[]> {
  const events = await fetchAllPages<Record<string, unknown>>(client, `/users/${userId}/events`, {
    maxPages: 10, // 最多获取 1000 条
    itemsPerPage: 100,
  });

  return events.map(e => ({
    id: String(e.id),
    type: (e.type as GitHubEventType) || 'PushEvent',
    repo: {
      name: String((e.repo as Record<string, unknown>)?.name ?? ''),
      url: String((e.repo as Record<string, unknown>)?.url ?? ''),
    },
    payload: (e.payload as Record<string, unknown>) || {},
    createdAt: String(e.created_at),
  }));
}
```

```typescript
// server/agent/tools/get-stars.ts

import { GitHubClient, fetchAllPages } from './github';
import type { GitHubStarredRepo } from '../../../shared/types';

export async function getUserStars(
  client: GitHubClient,
  userId: string
): Promise<GitHubStarredRepo[]> {
  const stars = await fetchAllPages<Record<string, unknown>>(client, `/users/${userId}/starred`, {
    maxPages: 10,
    itemsPerPage: 100,
  });

  return stars.map(s => ({
    id: Number(s.id),
    name: String(s.name),
    fullName: String(s.full_name),
    description: (s.description as string) || null,
    language: (s.language as string) || null,
    topics: Array.isArray(s.topics) ? s.topics.map(String) : [],
    stargazersCount: Number(s.stargazers_count),
  }));
}
```

---

## 5. Agent 类型定义

```typescript
// server/agent/types.ts

export type Phase =
  | 'INIT'
  | 'FETCHING_PROFILE'
  | 'FETCHING_REPOS'
  | 'FETCHING_EVENTS'
  | 'FETCHING_STARS'
  | 'BUILDING_REPORT'
  | 'DONE'
  | 'ERROR';

export interface AnalysisContext {
  userId: string;
  phase: Phase;
  profile: import('../../shared/types').GitHubUser | null;
  repos: import('../../shared/types').GitHubRepo[];
  events: import('../../shared/types').GitHubEvent[];
  stars: import('../../shared/types').GitHubStarredRepo[];
  error: import('./tools/github').GitHubError | null;
  startedAt: number;
}

export interface SchedulerOutput {
  nextPhase: Phase;
  execute: () => Promise<void>;
}
```

---

## 6. 动作调度器

```typescript
// server/agent/scheduler.ts

import type { AnalysisContext, SchedulerOutput } from './types';
import type { Phase } from './types';
import { getUserProfile } from './tools/get-profile';
import { getUserRepos } from './tools/get-repos';
import { getUserEvents } from './tools/get-events';
import { getUserStars } from './tools/get-stars';
import type { GitHubClient } from './tools/github';

export function schedule(
  ctx: AnalysisContext,
  client: GitHubClient
): SchedulerOutput {
  switch (ctx.phase) {
    case 'INIT':
      return {
        nextPhase: 'FETCHING_PROFILE',
        execute: async () => {
          ctx.profile = await getUserProfile(client, ctx.userId);
        },
      };

    case 'FETCHING_PROFILE':
      return {
        nextPhase: 'FETCHING_REPOS',
        execute: async () => {
          ctx.repos = await getUserRepos(client, ctx.userId);
        },
      };

    case 'FETCHING_REPOS':
      return {
        nextPhase: 'FETCHING_EVENTS',
        execute: async () => {
          ctx.events = await getUserEvents(client, ctx.userId);
        },
      };

    case 'FETCHING_EVENTS':
      return {
        nextPhase: 'FETCHING_STARS',
        execute: async () => {
          ctx.stars = await getUserStars(client, ctx.userId);
        },
      };

    case 'FETCHING_STARS':
      return {
        nextPhase: 'BUILDING_REPORT',
        execute: async () => {
          // 报告构建在 reactor 中直接调用 buildReport()
        },
      };

    default:
      throw new Error(`Invalid phase for scheduling: ${ctx.phase}`);
  }
}
```

---

## 7. ReAct 主循环

```typescript
// server/agent/reactor.ts

import type { AnalysisContext } from './types';
import type { Phase } from './types';
import { GitHubClient } from './tools/github';
import { schedule } from './scheduler';
import { buildReport } from './report-builder';
import type { SSEEmitter } from '../lib/sse';

const MAX_EXECUTION_MS = 60_000;

const PHASE_MESSAGES: Record<Phase, string> = {
  INIT: 'Initializing analysis...',
  FETCHING_PROFILE: 'Fetching user profile...',
  FETCHING_REPOS: 'Fetching repositories...',
  FETCHING_EVENTS: 'Fetching activity timeline...',
  FETCHING_STARS: 'Fetching starred repositories...',
  BUILDING_REPORT: 'Generating profile report...',
  DONE: 'Analysis complete.',
  ERROR: 'An error occurred.',
};

export async function runReactor(
  userId: string,
  token: string,
  emitter: SSEEmitter
): Promise<void> {
  const client = new GitHubClient(token);

  const ctx: AnalysisContext = {
    userId,
    phase: 'INIT',
    profile: null,
    repos: [],
    events: [],
    stars: [],
    error: null,
    startedAt: Date.now(),
  };

  try {
    while (ctx.phase !== 'DONE' && ctx.phase !== 'ERROR') {
      // 超时检查
      if (Date.now() - ctx.startedAt > MAX_EXECUTION_MS) {
        await emitter.emit('error', 'Analysis timeout (60s). Please try again.');
        ctx.phase = 'ERROR';
        return;
      }

      await emitter.emit('thinking', PHASE_MESSAGES[ctx.phase]);

      if (ctx.phase === 'BUILDING_REPORT') {
        // 报告构建是最后一个步骤
        const report = buildReport(ctx);
        await emitter.emit('final_report', report);
        ctx.phase = 'DONE';
        continue;
      }

      if (ctx.phase === 'DONE') {
        break;
      }

      const { nextPhase, execute } = schedule(ctx, client);

      try {
        await execute();
        ctx.phase = nextPhase;

        await emitter.emit('observation', formatObservation(ctx));
      } catch (err) {
        ctx.phase = 'ERROR';
        await emitter.emit('error', mapErrorToUserMessage(err as GitHubClient['fetch'] extends (e: string) => Promise<infer T> ? T : never));
        return;
      }
    }
  } catch (err) {
    ctx.phase = 'ERROR';
    await emitter.emit('error', mapErrorToUserMessage(err as Error));
  }
}

function formatObservation(ctx: AnalysisContext): string {
  switch (ctx.phase) {
    case 'FETCHING_PROFILE':
      return ctx.profile ? `Loaded profile: ${ctx.profile.login}` : 'No profile data';
    case 'FETCHING_REPOS':
      return `Found ${ctx.repos.length} repositories`;
    case 'FETCHING_EVENTS':
      return `Fetched ${ctx.events.length} events`;
    case 'FETCHING_STARS':
      return `Fetched ${ctx.stars.length} starred repos`;
    default:
      return '';
  }
}

function mapErrorToUserMessage(err: Error): string {
  if (err instanceof GitHubClient) {
    switch ((err as unknown as { status: number }).status) {
      case 404:
        return 'User not found. Please verify the GitHub ID.';
      case 403:
        return 'API rate limit exceeded. Please try again later.';
      default:
        return `Network error: ${err.message}`;
    }
  }
  return 'An unexpected error occurred. Please try again.';
}
```

---

## 8. SSE 事件流

### 8.1 Emitter 实现

```typescript
// server/lib/sse.ts

import type { SSEEvent } from '../../shared/types';

export class SSEEmitter {
  private controller: ReadableStreamDefaultController<Uint8Array>;
  private encoder = new TextEncoder();

  constructor(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.controller = controller;
  }

  async emit(type: SSEEvent['type'], content: string): Promise<void> {
    const event: SSEEvent = {
      type,
      content,
      timestamp: Date.now(),
    };

    const payload = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    this.controller.enqueue(this.encoder.encode(payload));
  }

  close(): void {
    try {
      this.controller.close();
    } catch {
      // Already closed
    }
  }
}

export function createSSEStream(): {
  stream: ReadableStream<Uint8Array>;
  emitter: SSEEmitter;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // Client disconnected
    },
  });

  return {
    stream,
    emitter: new SSEEmitter(controller),
  };
}
```

### 8.2 API Handler

```typescript
// server/api/analyze.post.ts

import { defineEventHandler, readBody, createError, sendStream } from 'h3';
import { runReactor } from '../agent/reactor';
import { createSSEStream } from '../lib/sse';

const GITHUB_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export default defineEventHandler(async (event) => {
  const body = await readBody(event);

  if (!body?.githubId || typeof body.githubId !== 'string') {
    throw createError({ statusCode: 400, message: 'githubId is required' });
  }

  const githubId = body.githubId.trim();

  if (!GITHUB_ID_PATTERN.test(githubId)) {
    throw createError({ statusCode: 400, message: 'Invalid GitHub ID format' });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw createError({ statusCode: 500, message: 'Server misconfigured: missing GITHUB_TOKEN' });
  }

  const { stream, emitter } = createSSEStream();

  // 异步执行，不阻塞响应
  runReactor(githubId, token, emitter).catch(err => {
    console.error('[PersonaHub] Reactor error:', err);
    emitter.emit('error', 'Internal server error').catch(() => {});
  });

  // 设置 SSE headers
  event.node.res.setHeaders({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 Nginx buffering
  });

  return sendStream(event, stream);
});
```

---

## 9. 报告生成器

### 9.1 数据结构

```typescript
// server/agent/report-builder.ts

export interface ProfileReport {
  basicInfo: {
    username: string;
    avatarUrl: string;
    userId: number;
    bio: string | null;
    publicRepos: number;
    followers: number;
    following: number;
  };
  techProfile: {
    topLanguages: Array<{ name: string; count: number; percentage: number }>;
    topDomains: Array<{ name: string; count: number }>;
    openSourceStyle: {
      selfBuilt: number;
      forked: number;
      selfBuiltRatio: number;
    };
    preferredTech: string[];
  };
  activeTime: {
    dayPattern: 'Weekday' | 'Weekend' | 'Balanced';
    hourPattern: 'Morning' | 'Afternoon' | 'Evening' | 'Night' | 'Balanced';
    peakHourUTC: number;
    weekendRatio: number;
  };
  recentActivity: {
    last90DaysEvents: number;
    eventTypeDistribution: Array<{ type: string; count: number }>;
    topProjects: Array<{ name: string; eventCount: number }>;
    techHotspots: string[];
  };
}
```

### 9.2 编程语言分析

```typescript
// server/agent/report-builder.ts

export function analyzeLanguages(repos: GitHubRepo[]): ProfileReport['techProfile']['topLanguages'] {
  const langCount = new Map<string, number>();

  for (const repo of repos) {
    if (repo.language) {
      langCount.set(repo.language, (langCount.get(repo.language) ?? 0) + 1);
    }
  }

  const total = repos.filter(r => r.language).length;
  if (total === 0) return [];

  return Array.from(langCount.entries())
    .map(([name, count]) => ({
      name,
      count,
      percentage: Math.round((count / total) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}
```

### 9.3 项目领域推断

```typescript
// server/agent/report-builder.ts

const DOMAIN_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['AI/ML', ['ai', 'ml', 'machine-learning', 'deep-learning', 'llm', 'gpt', 'transformer', 'torch', 'tensorflow', 'pytorch', 'huggingface', 'diffusion', 'neural', 'reinforcement']],
  ['Web Dev', ['web', 'frontend', 'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'remix', 'css', 'html', 'http', 'rest', 'graphql', 'webpack', 'vite']],
  ['Backend', ['api', 'server', 'backend', 'express', 'fastify', 'koa', 'django', 'flask', 'rails', 'spring', 'grpc', 'microservice']],
  ['Mobile', ['mobile', 'ios', 'android', 'react-native', 'flutter', 'swift', 'kotlin', 'xamarin', 'cordova', 'expo']],
  ['DevOps', ['docker', 'kubernetes', 'k8s', 'ci', 'cd', 'deploy', 'terraform', 'ansible', 'helm', 'ingress', 'pipeline', 'argocd']],
  ['Cloud', ['aws', 'gcp', 'azure', 'cloud', 'serverless', 'lambda', 'function', 'infrastructure', 'cloudformation', 'pulumi']],
  ['Database', ['database', 'db', 'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'postgres', 'sqlite', 'prisma']],
  ['Tooling', ['cli', 'tool', 'utility', 'script', 'automation', 'parser', 'generator', 'builder', 'makefile', 'task']],
  ['Security', ['security', 'crypto', 'cryptography', 'auth', 'oauth', 'jwt', 'ssl', 'tls', 'penetration', 'audit']],
  ['Data Eng', ['data', 'analytics', 'pipeline', 'etl', 'spark', 'kafka', 'stream', 'batch', 'airflow', 'dbt']],
]);

export function analyzeDomains(repos: GitHubRepo[]): ProfileReport['techProfile']['topDomains'] {
  const domainScores = new Map<string, number>();

  for (const repo of repos) {
    const searchableText = [
      repo.name,
      repo.description ?? '',
      ...repo.topics,
    ].join(' ').toLowerCase();

    for (const [domain, keywords] of DOMAIN_KEYWORDS) {
      const score = keywords.filter(kw => searchableText.includes(kw)).length;
      if (score > 0) {
        domainScores.set(domain, (domainScores.get(domain) ?? 0) + score);
      }
    }
  }

  return Array.from(domainScores.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}
```

### 9.4 开源风格分析

```typescript
// server/agent/report-builder.ts

export function analyzeOpenSourceStyle(
  repos: GitHubRepo[]
): ProfileReport['techProfile']['openSourceStyle'] {
  const selfBuilt = repos.filter(r => !r.fork).length;
  const forked = repos.filter(r => r.fork).length;
  const total = repos.length;

  return {
    selfBuilt,
    forked,
    selfBuiltRatio: total > 0 ? Math.round((selfBuilt / total) * 100) : 0,
  };
}
```

### 9.5 偏好技术提取

```typescript
// server/agent/report-builder.ts

export function extractPreferredTech(
  repos: GitHubRepo[],
  stars: GitHubStarredRepo[]
): string[] {
  const allTopics: string[] = [];

  for (const repo of [...repos, ...stars]) {
    allTopics.push(...repo.topics);
  }

  // 统计 topic 出现频率
  const topicCount = new Map<string, number>();
  for (const topic of allTopics) {
    topicCount.set(topic, (topicCount.get(topic) ?? 0) + 1);
  }

  return Array.from(topicCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic]) => topic);
}
```

### 9.6 活跃时间分析

```typescript
// server/agent/report-builder.ts

type DayPattern = 'Weekday' | 'Weekend' | 'Balanced';
type HourPattern = 'Morning' | 'Afternoon' | 'Evening' | 'Night' | 'Balanced';

export function analyzeActiveTime(
  events: GitHubEvent[]
): ProfileReport['activeTime'] {
  const hourCounts = new Array(24).fill(0);
  let weekdayCount = 0;
  let weekendCount = 0;

  for (const event of events) {
    const date = new Date(event.createdAt);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();

    hourCounts[hour]++;

    if (day === 0 || day === 6) {
      weekendCount++;
    } else {
      weekdayCount++;
    }
  }

  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const total = weekdayCount + weekendCount || 1;
  const weekendRatio = weekendCount / total;

  return {
    dayPattern: classifyDayPattern(weekendRatio),
    hourPattern: classifyHourPattern(hourCounts),
    peakHourUTC: peakHour,
    weekendRatio: Math.round(weekendRatio * 100) / 100,
  };
}

function classifyDayPattern(weekendRatio: number): DayPattern {
  if (weekendRatio > 0.6) return 'Weekend';
  if (weekendRatio < 0.4) return 'Weekday';
  return 'Balanced';
}

function classifyHourPattern(hourCounts: number[]): HourPattern {
  const [morning, afternoon, evening, night] = [0, 0, 0, 0];

  for (let h = 0; h < 24; h++) {
    const count = hourCounts[h];
    if (h >= 6 && h < 12) morning += count;
    else if (h >= 12 && h < 18) afternoon += count;
    else if (h >= 18 && h < 22) evening += count;
    else night += count;
  }

  const total = morning + afternoon + evening + night || 1;
  const maxRatio = Math.max(morning, afternoon, evening, night) / total;

  if (maxRatio < 0.35) return 'Balanced';
  if (morning === Math.max(morning, afternoon, evening, night)) return 'Morning';
  if (afternoon === Math.max(morning, afternoon, evening, night)) return 'Afternoon';
  if (evening === Math.max(morning, afternoon, evening, night)) return 'Evening';
  return 'Night';
}
```

### 9.7 最近动态分析

```typescript
// server/agent/report-builder.ts

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function analyzeRecentActivity(
  events: GitHubEvent[]
): ProfileReport['recentActivity'] {
  const cutoff = Date.now() - NINETY_DAYS_MS;
  const recentEvents = events.filter(e => new Date(e.createdAt).getTime() >= cutoff);

  // 事件类型分布
  const typeCount = new Map<string, number>();
  const projectCount = new Map<string, number>();

  for (const event of recentEvents) {
    typeCount.set(event.type, (typeCount.get(event.type) ?? 0) + 1);
    projectCount.set(event.repo.name, (projectCount.get(event.repo.name) ?? 0) + 1);
  }

  // 技术热点提取
  const hotspots = extractTechHotspots(recentEvents);

  return {
    last90DaysEvents: recentEvents.length,
    eventTypeDistribution: Array.from(typeCount.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    topProjects: Array.from(projectCount.entries())
      .map(([name, eventCount]) => ({ name, eventCount }))
      .sort((a, b) => b.eventCount - a.eventCount)
      .slice(0, 5),
    techHotspots: hotspots,
  };
}

function extractTechHotspots(events: GitHubEvent[]): string[] {
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'from', 'with', 'core', 'main', 'node', 'lib',
  ]);

  const wordCount = new Map<string, number>();

  for (const event of events) {
    const words = event.repo.name
      .toLowerCase()
      .split(/[-_/]/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    for (const word of words) {
      wordCount.set(word, (wordCount.get(word) ?? 0) + 1);
    }
  }

  return Array.from(wordCount.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
```

### 9.8 报告构建入口

```typescript
// server/agent/report-builder.ts

import type { AnalysisContext } from './types';
import type { GitHubRepo, GitHubStarredRepo, GitHubEvent } from '../../shared/types';

export function buildReport(ctx: AnalysisContext): string {
  if (!ctx.profile) {
    return 'Unable to generate report: profile not available.';
  }

  const langs = analyzeLanguages(ctx.repos);
  const domains = analyzeDomains(ctx.repos);
  const ossStyle = analyzeOpenSourceStyle(ctx.repos);
  const preferredTech = extractPreferredTech(ctx.repos, ctx.stars);
  const activeTime = analyzeActiveTime(ctx.events);
  const recentActivity = analyzeRecentActivity(ctx.events);

  return formatMarkdown({
    basicInfo: {
      username: ctx.profile.login,
      avatarUrl: ctx.profile.avatarUrl,
      userId: ctx.profile.id,
      bio: ctx.profile.bio,
      publicRepos: ctx.profile.publicRepos,
      followers: ctx.profile.followers,
      following: ctx.profile.following,
    },
    techProfile: {
      topLanguages: langs,
      topDomains: domains,
      openSourceStyle: ossStyle,
      preferredTech,
    },
    activeTime,
    recentActivity,
  });
}

function formatMarkdown(report: ProfileReport): string {
  const { basicInfo, techProfile, activeTime, recentActivity } = report;

  const lines: string[] = [
    '# GitHub User Profile Report',
    '',
    '## Basic Information',
    `| Item | Value |`,
    `|------|-------|`,
    `| Username | @${basicInfo.username} |`,
    `| User ID | ${basicInfo.userId} |`,
    basicInfo.bio ? `| Bio | ${basicInfo.bio} |` : null,
    `| Public Repos | ${basicInfo.publicRepos} |`,
    `| Followers | ${basicInfo.followers} |`,
    `| Following | ${basicInfo.following} |`,
    '',
  ].filter(Boolean) as string[];

  if (techProfile.topLanguages.length > 0) {
    lines.push('## Top Languages');
    lines.push('| Language | Count | Percentage |');
    lines.push('|----------|-------|------------|');
    for (const lang of techProfile.topLanguages) {
      lines.push(`| ${lang.name} | ${lang.count} | ${lang.percentage}% |`);
    }
    lines.push('');
  }

  if (techProfile.topDomains.length > 0) {
    lines.push('## Technical Domains');
    lines.push('| Domain | Score |');
    lines.push('|--------|-------|');
    for (const domain of techProfile.topDomains) {
      lines.push(`| ${domain.name} | ${domain.count} |`);
    }
    lines.push('');
  }

  if (techProfile.preferredTech.length > 0) {
    lines.push('## Preferred Technologies');
    lines.push(techProfile.preferredTech.map(t => `- ${t}`).join('\n'));
    lines.push('');
  }

  lines.push('## Open Source Style');
  lines.push(`- Own repositories: ${techProfile.openSourceStyle.selfBuilt}`);
  lines.push(`- Forked repositories: ${techProfile.openSourceStyle.forked}`);
  lines.push(`- Self-built ratio: ${techProfile.openSourceStyle.selfBuiltRatio}%`);
  lines.push('');

  lines.push('## Active Time Pattern');
  lines.push(`- Day pattern: ${activeTime.dayPattern}`);
  lines.push(`- Peak hour: ${activeTime.peakHourUTC}:00 (UTC)`);
  lines.push(`- Hour pattern: ${activeTime.hourPattern}`);
  lines.push(`- Weekend ratio: ${Math.round(activeTime.weekendRatio * 100)}%`);
  lines.push('');

  if (recentActivity.last90DaysEvents > 0) {
    lines.push('## Recent Activity (Last 90 Days)');
    lines.push(`Total events: ${recentActivity.last90DaysEvents}`);
    lines.push('');

    if (recentActivity.topProjects.length > 0) {
      lines.push('### Top Projects');
      lines.push('| Project | Events |');
      lines.push('|---------|--------|');
      for (const p of recentActivity.topProjects) {
        lines.push(`| ${p.name} | ${p.eventCount} |`);
      }
      lines.push('');
    }

    if (recentActivity.techHotspots.length > 0) {
      lines.push('### Tech Hotspots');
      lines.push(recentActivity.techHotspots.map(t => `- ${t}`).join('\n'));
      lines.push('');
    }
  } else {
    lines.push('## Recent Activity');
    lines.push('No public activity in the last 90 days.');
    lines.push('');
  }

  return lines.join('\n');
}
```

---

## 10. 前端实现

### 10.1 SSE 客户端 Hook

```typescript
// src/app/hooks/useAnalysis.ts

import { useState, useCallback, useRef } from 'react';
import type { SSEEvent } from '../../shared/types';

export interface UseAnalysisReturn {
  events: SSEEvent[];
  report: string | null;
  error: string | null;
  isLoading: boolean;
  startAnalysis: (githubId: string) => void;
  reset: () => void;
}

export function useAnalysis(): UseAnalysisReturn {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);

  const startAnalysis = useCallback((githubId: string) => {
    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setEvents([]);
    setReport(null);
    setError(null);
    setIsLoading(true);

    const url = `/api/analyze?githubId=${encodeURIComponent(githubId)}`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (e: MessageEvent) => {
      try {
        const data: SSEEvent = JSON.parse(e.data);

        switch (data.type) {
          case 'thinking':
          case 'observation':
            setEvents(prev => [...prev, data]);
            break;
          case 'final_report':
            setReport(data.content);
            setIsLoading(false);
            eventSource.close();
            break;
          case 'error':
            setError(data.content);
            setIsLoading(false);
            eventSource.close();
            break;
          case 'done':
            setIsLoading(false);
            eventSource.close();
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = () => {
      setError('Connection failed. Please check your network and try again.');
      setIsLoading(false);
      eventSource.close();
    };
  }, []);

  const reset = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setEvents([]);
    setReport(null);
    setError(null);
    setIsLoading(false);
  }, []);

  return { events, report, error, isLoading, startAnalysis, reset };
}
```

### 10.2 组件实现

```typescript
// src/app/components/SearchBar.tsx

import React, { useState } from 'react';

interface SearchBarProps {
  onSearch: (githubId: string) => void;
  isLoading: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({ onSearch, isLoading }) => {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (trimmed && !isLoading) {
      onSearch(trimmed);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '8px' }}>
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="Enter GitHub User ID"
        disabled={isLoading}
        style={{ flex: 1, padding: '8px 12px' }}
      />
      <button type="submit" disabled={isLoading || !input.trim()}>
        {isLoading ? 'Analyzing...' : 'Analyze'}
      </button>
    </form>
  );
};
```

```typescript
// src/app/components/ThinkingStream.tsx

import React, { useEffect, useRef } from 'react';
import type { SSEEvent } from '../../shared/types';

interface ThinkingStreamProps {
  events: SSEEvent[];
}

export const ThinkingStream: React.FC<ThinkingStreamProps> = ({ events }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div style={{ maxHeight: '400px', overflowY: 'auto', padding: '12px' }}>
      {events.map((event, i) => (
        <div key={i} style={{ marginBottom: '8px', opacity: 0.9 }}>
          <span style={{ color: '#666' }}>
            {event.type === 'thinking' ? '💭' : '✅'}
          </span>
          {' '}
          {event.content}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
};
```

```typescript
// src/app/components/ProfileReport.tsx

import React from 'react';

interface ProfileReportProps {
  report: string | null;
}

export const ProfileReport: React.FC<ProfileReportProps> = ({ report }) => {
  if (!report) return null;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(report).catch(() => {});
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={copyToClipboard}
        style={{ position: 'absolute', top: '8px', right: '8px' }}
      >
        Copy
      </button>
      <pre
        style={{
          background: '#f5f5f5',
          padding: '16px',
          borderRadius: '8px',
          overflow: 'auto',
          maxHeight: '600px',
        }}
      >
        {report}
      </pre>
    </div>
  );
};
```

```typescript
// src/app/App.tsx

import React from 'react';
import { SearchBar } from './components/SearchBar';
import { ThinkingStream } from './components/ThinkingStream';
import { ProfileReport } from './components/ProfileReport';
import { useAnalysis } from './hooks/useAnalysis';

export default function App() {
  const { events, report, error, isLoading, startAnalysis, reset } = useAnalysis();

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '24px' }}>
      <h1>PersonaHub</h1>
      <SearchBar onSearch={startAnalysis} isLoading={isLoading} />

      {isLoading && events.length === 0 && (
        <p>Initializing analysis...</p>
      )}

      {events.length > 0 && <ThinkingStream events={events} />}

      {error && (
        <p style={{ color: 'red', marginTop: '16px' }}>Error: {error}</p>
      )}

      {report && (
        <div style={{ marginTop: '24px' }}>
          <ProfileReport report={report} />
        </div>
      )}
    </div>
  );
}
```

---

## 11. 配置文件

### 11.1 vite.config.ts

```typescript
// vite.config.ts

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import vitePlus from 'viteplus';

export default defineConfig({
  plugins: [
    vitePlus({
      // VitePlus 配置
    }),
    react(),
  ],
  server: {
    proxy: {
      // 本地开发时将 /api 请求代理到 Nitro
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
```

### 11.2 nitro.config.ts

```typescript
// nitro.config.ts

import { defineNitroConfig } from 'nitro';

export default defineNitroConfig({
  // 开发环境
  dev: {
    // 禁用 asset 预缓存避免冲突
    preset: 'node-server',
  },

  // 生产环境预设
  preset: process.env.NITRO_PRESET || 'vercel',

  // API 路由
  routeRules: {
    '/api/**': {
      cors: true,
      headers: {
        'Cache-Control': 'no-cache',
      },
    },
  },
});
```

### 11.3 package.json (关键依赖)

```json
{
  "name": "personahub",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "dev:server": "nitro dev",
    "build": "vite build && nitro build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "h3": "^1.13.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "nitro": "^3.1.0",
    "typescript": "^5.6.3",
    "vite": "^6.0.3",
    "viteplus": "^3.2.0"
  }
}
```

---

## 12. 错误处理

### 12.1 错误分类与响应

| 错误类型 | 触发条件 | 用户消息 | HTTP 状态码 |
|----------|----------|----------|-------------|
| 无效输入 | githubId 格式不符 | "Invalid GitHub ID format" | 400 |
| 用户不存在 | GitHub API 404 | "User not found. Please verify the GitHub ID." | — (SSE) |
| API 限流 | GitHub API 403 | "API rate limit exceeded. Please try again later." | — (SSE) |
| 请求超时 | 超过 60s | "Analysis timeout (60s). Please try again." | — (SSE) |
| 网络错误 | fetch 抛出异常 | "Network error. Please check your connection." | — (SSE) |
| 服务端错误 | 未捕获异常 | "Internal server error. Please try again later." | — (SSE) |
| 配置错误 | 缺少 GITHUB_TOKEN | (不返回给客户端) | 500 |

### 12.2 前端错误展示

```typescript
// useAnalysis.ts 中已处理
// error state 用于展示用户友好的错误消息
// 不直接暴露内部错误细节
```

---

## 13. 性能与资源

### 13.1 API 调用优化

- **分页上限**：单用户最多获取 5000 条事件（10 页 × 100 × 5 次请求）
- **并发控制**：同一 Token 的并发请求受 GitHub 速率限制约束
- **超时控制**：单次 fetch 超时 10s，全流程超时 60s

### 13.2 内存管理

- **流式处理**：SSE 边收边发，不积累大数据
- **上下文释放**：Reactor 完成后立即解除循环引用
- **数组截断**：超过 10000 条事件时截断旧数据

---

## 14. 部署

### 14.1 Vercel 部署

```bash
# vercel.json
{
  "builds": [
    { "src": "package.json", "use": "@vercel/nitro" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "/api/analyze" }
  ]
}
```

### 14.2 环境变量

```bash
# .env 或 Vercel Dashboard
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

**Token 权限要求**：
- `read:user` — 用户基本信息
- `public_repo` — 公开仓库、事件、stars
