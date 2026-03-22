# PersonaHub — 技术设计文档

## 1. 概述

本文档定义 PersonaHub 的技术架构与实现细节，面向开发者。

### 1.1 技术指标

| 指标 | 值 |
|------|-----|
| 技术栈 | VitePlus + @vitejs/plugin-react + Nitro |
| Agent 范式 | 规则化 ReAct 循环（无 LLM 依赖） |
| 数据源 | GitHub REST API v3 |
| 流式协议 | Server-Sent Events (SSE) |
| 目标平台 | Vercel / Railway / Cloudflare Workers |

### 1.2 系统约束

- **无 Token 前端输入**：GitHub PAT 配置于服务端环境变量
- **无状态持久化**：每次请求独立完成分析，无会话存储
- **请求超时**：单次分析最大耗时 60s，超时强制终止
- **API 配额**：GitHub REST API 速率限制 5000 req/hour（认证后）

---

## 2. 项目结构

```
personahub/
├── src/
│   ├── app/                         # 前端 (VitePlus entry)
│   │   ├── App.tsx                  # 根组件
│   │   ├── main.tsx                 # 入口文件
│   │   ├── index.html
│   │   └── components/
│   │       ├── SearchBar.tsx
│   │       ├── ThinkingStream.tsx
│   │       └── ProfileReport.tsx
│   │
│   ├── server/                      # 后端 (Nitro)
│   │   ├── api/
│   │   │   └── analyze.post.ts      # POST /api/analyze
│   │   │
│   │   ├── agent/
│   │   │   ├── index.ts             # Agent Facade
│   │   │   ├── types.ts             # 状态 & 工具类型定义
│   │   │   ├── reactor.ts           # ReAct 循环实现
│   │   │   ├── scheduler.ts         # 动作调度器
│   │   │   ├── report-builder.ts    # 报告生成
│   │   │   │
│   │   │   └── tools/               # GitHub API 工具集
│   │   │       ├── github-client.ts # API 客户端封装
│   │   │       ├── getUserProfile.ts
│   │   │       ├── getUserRepos.ts
│   │   │       ├── getUserEvents.ts
│   │   │       ├── getUserStars.ts
│   │   │       └── errors.ts        # 错误类型
│   │   │
│   │   └── lib/
│   │       └── sse.ts               # SSE Emitter 实现
│   │
│   └── shared/
│       └── types.ts                 # 跨端类型定义
│
├── package.json
├── nitro.config.ts
├── vite.config.ts
└── tsconfig.json
```

---

## 3. 类型系统

### 3.1 共享类型

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
  | 'PullRequestReviewEvent';

export interface GitHubEvent {
  id: string;
  type: GitHubEventType;
  repo: { name: string; url: string };
  payload: Record<string, unknown>;
  createdAt: string;  // ISO 8601
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
```

### 3.2 Agent 状态机类型

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
  profile: GitHubUser | null;
  repos: GitHubRepo[];
  events: GitHubEvent[];
  stars: GitHubStarredRepo[];
  error: GitHubAPIError | null;
  startedAt: number;  // timestamp for timeout tracking
}

export interface GitHubAPIError extends Error {
  status: number;
  endpoint: string;
}
```

### 3.3 SSE 事件类型

```typescript
// server/agent/types.ts

export type SSEEventType =
  | 'thinking'
  | 'observation'
  | 'final_report'
  | 'error'
  | 'done';

export interface SSEEvent {
  type: SSEEventType;
  content: string;
  timestamp?: number;
}
```

---

## 4. GitHub API 客户端

### 4.1 客户端封装

```typescript
// server/agent/tools/github-client.ts

const BASE_URL = 'https://api.github.com';
const TIMEOUT_MS = 10000;
const RETRY_CONFIG = {
  maxRetries: 2,
  backoffMs: [100, 500],
};

export class GitHubClient {
  constructor(private readonly token: string) {}

  async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${BASE_URL}${endpoint}`;

    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'PersonaHub/1.0',
            ...options.headers,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw this.mapStatusToError(response.status, endpoint);
        }

        return response.json();
      } catch (err) {
        if (attempt === RETRY_CONFIG.maxRetries) throw err;
        if (this.isRetryableError(err)) {
          await this.delay(RETRY_CONFIG.backoffMs[attempt]);
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unexpected loop exit');
  }

  private mapStatusToError(status: number, endpoint: string): GitHubAPIError {
    const error = new Error() as GitHubAPIError;
    error.status = status;
    error.endpoint = endpoint;

    switch (status) {
      case 404:
        error.message = 'User not found';
        break;
      case 403:
        error.message = 'Rate limit exceeded';
        break;
      case 500:
      case 502:
      case 503:
        error.message = 'GitHub API unavailable';
        break;
      default:
        error.message = `GitHub API error: ${status}`;
    }
    return error;
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof Error && err.name === 'AbortError') return false;
    if (err instanceof GitHubAPIError) {
      return [403, 500, 502, 503].includes(err.status);
    }
    return true;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 4.2 分页处理

```typescript
// server/agent/tools/github-client.ts

export interface PaginatedResponse<T> {
  data: T[];
  hasMore: boolean;
  nextPage: number | null;
}

export async function fetchAllPages<T>(
  client: GitHubClient,
  endpoint: string,
  maxPages: number = 5
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  while (page <= maxPages) {
    const data = await client.fetch<T[]>(`${endpoint}?per_page=100&page=${page}`);
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }

  return results;
}
```

### 4.3 工具函数签名

```typescript
// server/agent/tools/getUserProfile.ts
export async function getUserProfile(
  client: GitHubClient,
  userId: string
): Promise<GitHubUser>;

// server/agent/tools/getUserRepos.ts
export async function getUserRepos(
  client: GitHubClient,
  userId: string
): Promise<GitHubRepo[]>;

// server/agent/tools/getUserEvents.ts
export async function getUserEvents(
  client: GitHubClient,
  userId: string
): Promise<GitHubEvent[]>;

// server/agent/tools/getUserStars.ts
export async function getUserStars(
  client: GitHubClient,
  userId: string
): Promise<GitHubStarredRepo[]>;
```

---

## 5. ReAct 循环实现

### 5.1 状态转移图

```
       ┌────────────────────────────────────────────────────────────┐
       │                                                            │
       ▼                                                            │
   ┌───────┐     ┌──────────────┐     ┌───────────────┐           │
   │ INIT  │────►│FETCHING_PROFILE│────►│ FETCHING_REPOS │           │
   └───────┘     └──────┬───────┘     └───────┬───────┘           │
                        │                       │                   │
                        │ error                 │ error              │
                        ▼                       ▼                    │
                   ┌─────────┐            ┌───────────┐              │
                   │  ERROR  │            │FETCHING_  │              │
                   │(SSE err)│            │  EVENTS   │              │
                   └─────────┘            └─────┬─────┘              │
                                                 │                     │
                                                 │ error               │
                                                 ▼                     │
                                           ┌─────────────┐            │
                                           │FETCHING_STARS│            │
                                           └──────┬──────┘            │
                                                  │                    │
                                                  │ error              │
                                                  ▼                    │
                                           ┌──────────────┐           │
                                           │BUILDING_REPORT│           │
                                           └──────┬───────┘           │
                                                  │                    │
                                                  ▼                    │
                                            ┌─────────┐                │
                                            │  DONE   │◄───────────────┘
                                            └─────────┘  (report built)
```

### 5.2 动作调度器

```typescript
// server/agent/scheduler.ts

import { Phase, AnalysisContext } from './types';
import { GitHubClient } from './tools/github-client';
import * as tools from './tools';

export interface SchedulerResult {
  nextPhase: Phase;
  action: () => Promise<void>;
}

export function decideNextAction(
  ctx: AnalysisContext
): SchedulerResult {
  switch (ctx.phase) {
    case 'INIT':
      return {
        nextPhase: 'FETCHING_PROFILE',
        action: async () => {
          ctx.profile = await tools.getUserProfile(ctx.userId);
        },
      };

    case 'FETCHING_PROFILE':
      return {
        nextPhase: 'FETCHING_REPOS',
        action: async () => {
          ctx.repos = await tools.getUserRepos(ctx.userId);
        },
      };

    case 'FETCHING_REPOS':
      return {
        nextPhase: 'FETCHING_EVENTS',
        action: async () => {
          ctx.events = await tools.getUserEvents(ctx.userId);
        },
      };

    case 'FETCHING_EVENTS':
      return {
        nextPhase: 'FETCHING_STARS',
        action: async () => {
          ctx.stars = await tools.getUserStars(ctx.userId);
        },
      };

    case 'FETCHING_STARS':
      return {
        nextPhase: 'BUILDING_REPORT',
        action: async () => {
          // Report building is handled separately in reactor
        },
      };

    default:
      throw new Error(`Invalid phase transition from ${ctx.phase}`);
  }
}
```

### 5.3 Reactor 主循环

```typescript
// server/agent/reactor.ts

import { AnalysisContext, Phase } from './types';
import { SSEEmitter } from '../lib/sse';
import { GitHubClient } from './tools/github-client';
import { decideNextAction } from './scheduler';
import { buildReport } from './report-builder';

const MAX_EXECUTION_TIME_MS = 60_000;

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
      // Timeout guard
      if (Date.now() - ctx.startedAt > MAX_EXECUTION_TIME_MS) {
        await emitter.emit('error', 'Analysis timeout exceeded (60s)');
        return;
      }

      const { nextPhase, action } = decideNextAction(ctx);

      await emitter.emit('thinking', getPhaseThinkingMessage(ctx.phase));

      try {
        await action();
        ctx.phase = nextPhase;

        await emitter.emit('observation', getPhaseObservation(ctx));
      } catch (err) {
        ctx.error = err as GitHubAPIError;
        ctx.phase = 'ERROR';
        await handleError(err as GitHubAPIError, emitter);
        return;
      }
    }

    // Build and emit final report
    if (ctx.phase === 'DONE') {
      await emitter.emit('final_report', buildReport(ctx));
    }
  } catch (err) {
    ctx.error = err as GitHubAPIError;
    await handleError(err as GitHubAPIError, emitter);
  }
}

function getPhaseThinkingMessage(phase: Phase): string {
  const messages: Record<Phase, string> = {
    INIT: 'Initializing analysis...',
    FETCHING_PROFILE: 'Fetching user profile...',
    FETCHING_REPOS: 'Fetching repository list...',
    FETCHING_EVENTS: 'Fetching activity timeline...',
    FETCHING_STARS: 'Fetching starred repositories...',
    BUILDING_REPORT: 'Building profile report...',
    DONE: 'Analysis complete.',
    ERROR: 'An error occurred.',
  };
  return messages[phase];
}

function getPhaseObservation(ctx: AnalysisContext): string {
  switch (ctx.phase) {
    case 'FETCHING_PROFILE':
      return ctx.profile ? `Profile loaded: ${ctx.profile.login}` : 'No profile data';
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

async function handleError(
  err: GitHubAPIError,
  emitter: SSEEmitter
): Promise<void> {
  const userMessage = mapErrorToUserMessage(err);
  await emitter.emit('error', userMessage);
}

function mapErrorToUserMessage(err: GitHubAPIError): string {
  switch (err.status) {
    case 404:
      return 'User not found. Please verify the GitHub ID.';
    case 403:
      return 'API rate limit exceeded. Please try again later.';
    default:
      return `Network error: ${err.message}`;
  }
}
```

---

## 6. SSE 事件流

### 6.1 Emitter 实现

```typescript
// server/lib/sse.ts

import type { SSEEventType } from '../shared/types';

export class SSEEmitter {
  private controller: ReadableStreamDefaultController<Uint8Array>;
  private encoder = new TextEncoder();

  constructor(stream: ReadableStream<Uint8Array>) {
    this.controller = stream.getReader().controller as ReadableStreamDefaultController<Uint8Array>;
  }

  async emit(type: SSEEventType, content: string): Promise<void> {
    const data = JSON.stringify({ type, content, timestamp: Date.now() });
    const payload = `event: ${type}\ndata: ${data}\n\n`;
    this.controller.enqueue(this.encoder.encode(payload));
  }

  close(): void {
    this.controller.close();
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
      // Cleanup if needed
    },
  });

  return {
    stream,
    emitter: new SSEEmitter(stream),
  };
}
```

### 6.2 API Handler 集成

```typescript
// server/api/analyze.post.ts

import { defineEventHandler, readBody, createError } from 'h3';
import { runReactor } from '../agent/reactor';
import { createSSEStream } from '../lib/sse';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { githubId } = body;

  if (!githubId || typeof githubId !== 'string') {
    throw createError({ statusCode: 400, message: 'githubId is required' });
  }

  // Validate githubId format (alphanumeric, -)
  if (!/^[a-zA-Z0-9-]+$/.test(githubId)) {
    throw createError({ statusCode: 400, message: 'Invalid GitHub ID format' });
  }

  const { stream, emitter } = createSSEStream();

  // Get token from environment
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    emitter.emit('error', 'Server configuration error');
    emitter.close();
    return;
  }

  // Run reactor without blocking
  runReactor(githubId, token, emitter).catch(console.error);

  // Return SSE stream
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
```

---

## 7. 报告生成器

### 7.1 报告数据结构

```typescript
// server/agent/report-builder.ts

export interface ProfileReport {
  basicInfo: BasicInfoSection;
  techProfile: TechProfileSection;
  activeTime: ActiveTimeSection;
  recentActivity: RecentActivitySection;
}

export interface BasicInfoSection {
  username: string;
  avatarUrl: string;
  id: number;
  bio: string | null;
  publicRepos: number;
  followers: number;
  following: number;
}

export interface TechProfileSection {
  topLanguages: Array<{ name: string; count: number; percentage: number }>;
  topDomains: Array<{ name: string; count: number }>;
  openSourceStyle: {
    selfBuilt: number;       // Own repos count
    forked: number;           // Forked repos with modifications
    collaborative: number;   // PRs merged, org memberships
    selfBuiltRatio: number;  // Percentage
  };
  preferredTech: string[];    // Extracted from repo topics + star themes
}

export interface ActiveTimeSection {
  dayPattern: 'Weekday' | 'Weekend' | 'Balanced';
  hourPattern: 'Morning' | 'Afternoon' | 'Evening' | 'Night' | 'Balanced';
  peakHourUTC: number;
  weekendRatio: number;
}

export interface RecentActivitySection {
  last90DaysEvents: number;
  eventTypeDistribution: Array<{ type: string; count: number }>;
  topProjects: Array<{ name: string; eventCount: number }>;
  techHotspots: string[];
}
```

### 7.2 编程语言分析

```typescript
// server/agent/report-builder.ts

export function analyzeLanguages(repos: GitHubRepo[]): TechProfileSection['topLanguages'] {
  const langCount = new Map<string, number>();

  for (const repo of repos) {
    if (repo.language) {
      langCount.set(repo.language, (langCount.get(repo.language) ?? 0) + 1);
    }
  }

  const total = repos.length;
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

### 7.3 项目领域推断

```typescript
// server/agent/report-builder.ts

const DOMAIN_KEYWORDS: Record<string, string[]> = Object.freeze({
  'AI/ML': ['ai', 'ml', 'machine-learning', 'deep-learning', 'llm', 'gpt', 'transformer', 'torch', 'tensorflow', 'pytorch', 'huggingface'],
  'Web Dev': ['web', 'frontend', 'react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxt', 'css', 'html', 'http', 'rest', 'graphql'],
  'Backend': ['api', 'server', 'backend', 'express', 'fastify', 'koa', 'django', 'flask', 'rails', 'spring', 'grpc'],
  'Mobile': ['mobile', 'ios', 'android', 'react-native', 'flutter', 'swift', 'kotlin', 'xamarin'],
  'DevOps': ['docker', 'kubernetes', 'k8s', 'ci', 'cd', 'deploy', 'terraform', 'ansible', 'helm', 'ingress'],
  'Cloud': ['aws', 'gcp', 'azure', 'cloud', 'serverless', 'lambda', 'function', 'infrastructure'],
  'Database': ['database', 'db', 'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'postgres'],
  'Tooling': ['cli', 'tool', 'utility', 'script', 'automation', 'parser', 'generator', 'builder'],
  'Security': ['security', 'crypto', 'cryptography', 'auth', 'oauth', 'jwt', 'ssl', 'tls'],
  'Data': ['data', 'analytics', 'pipeline', 'etl', 'spark', 'kafka', 'stream', 'batch'],
});

export function analyzeDomains(repos: GitHubRepo[]): TechProfileSection['topDomains'] {
  const domainScores = new Map<string, number>();

  for (const repo of repos) {
    const text = [
      repo.name,
      repo.description ?? '',
      ...repo.topics,
    ].join(' ').toLowerCase();

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      const matches = keywords.filter(kw => text.includes(kw)).length;
      if (matches > 0) {
        domainScores.set(domain, (domainScores.get(domain) ?? 0) + matches);
      }
    }
  }

  return Array.from(domainScores.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}
```

### 7.4 活跃时间分析

```typescript
// server/agent/report-builder.ts

type DayPattern = 'Weekday' | 'Weekend' | 'Balanced';
type HourPattern = 'Morning' | 'Afternoon' | 'Evening' | 'Night' | 'Balanced';

export function analyzeActiveTime(events: GitHubEvent[]): ActiveTimeSection {
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
  const total = weekdayCount + weekendCount;
  const weekendRatio = total > 0 ? weekendCount / total : 0.5;

  return {
    dayPattern: classifyDayPattern(weekendRatio),
    hourPattern: classifyHourPattern(peakHour),
    peakHourUTC: peakHour,
    weekendRatio: Math.round(weekendRatio * 100) / 100,
  };
}

function classifyDayPattern(weekendRatio: number): DayPattern {
  if (weekendRatio > 0.6) return 'Weekend';
  if (weekendRatio < 0.4) return 'Weekday';
  return 'Balanced';
}

function classifyHourPattern(peakHour: number): HourPattern {
  if (peakHour >= 6 && peakHour < 12) return 'Morning';
  if (peakHour >= 12 && peakHour < 18) return 'Afternoon';
  if (peakHour >= 18 && peakHour < 22) return 'Evening';
  return 'Night';
}
```

### 7.5 最近动态分析

```typescript
// server/agent/report-builder.ts

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function analyzeRecentActivity(events: GitHubEvent[]): RecentActivitySection {
  const now = Date.now();
  const cutoff = now - NINETY_DAYS_MS;

  // Filter to last 90 days
  const recentEvents = events.filter(e => new Date(e.createdAt).getTime() >= cutoff);

  // Event type distribution
  const typeCount = new Map<string, number>();
  const projectCount = new Map<string, number>();

  for (const event of recentEvents) {
    typeCount.set(event.type, (typeCount.get(event.type) ?? 0) + 1);
    projectCount.set(event.repo.name, (projectCount.get(event.repo.name) ?? 0) + 1);
  }

  // Tech hotspots from repo names and topics
  const hotspots = extractHotspots(recentEvents);

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

function extractHotspots(events: GitHubEvent[]): string[] {
  const wordCount = new Map<string, number>();
  const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'in', 'for', 'of', 'on', 'with', 'by', 'from', 'is']);

  for (const event of events) {
    const words = event.repo.name.toLowerCase().split(/[-_/]/);
    for (const word of words) {
      if (word.length > 2 && !STOP_WORDS.has(word)) {
        wordCount.set(word, (wordCount.get(word) ?? 0) + 1);
      }
    }
  }

  return Array.from(wordCount.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
```

### 7.6 报告构建入口

```typescript
// server/agent/report-builder.ts

export function buildReport(ctx: AnalysisContext): string {
  const basicInfo = buildBasicInfo(ctx.profile!);
  const techProfile = buildTechProfile(ctx.repos, ctx.stars);
  const activeTime = analyzeActiveTime(ctx.events);
  const recentActivity = analyzeRecentActivity(ctx.events);

  return formatMarkdown({ basicInfo, techProfile, activeTime, recentActivity });
}

function formatMarkdown(report: ProfileReport): string {
  // Generate structured Markdown report
  // (Implementation details for formatting)
  return `## Basic Info\n\n...`;
}
```

---

## 8. 前端组件

### 8.1 组件接口定义

```typescript
// src/app/components/SearchBar.tsx

interface SearchBarProps {
  onSearch: (githubId: string) => void;
  isLoading: boolean;
}

interface ThinkingStreamProps {
  events: SSEEvent[];
}

interface ProfileReportProps {
  report: string | null;
}
```

### 8.2 SSE 客户端

```typescript
// src/app/hooks/useAnalysis.ts

import { useState, useCallback, useRef } from 'react';
import type { SSEEvent } from '../../shared/types';

export function useAnalysis() {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const startAnalysis = useCallback((githubId: string) => {
    // Cleanup previous connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setEvents([]);
    setReport(null);
    setError(null);
    setIsLoading(true);

    const eventSource = new EventSource(`/api/analyze?githubId=${encodeURIComponent(githubId)}`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data) as SSEEvent;

      if (data.type === 'error') {
        setError(data.content);
        setIsLoading(false);
        eventSource.close();
        return;
      }

      if (data.type === 'final_report') {
        setReport(data.content);
        setIsLoading(false);
        eventSource.close();
        return;
      }

      if (data.type === 'done') {
        setIsLoading(false);
        eventSource.close();
        return;
      }

      setEvents(prev => [...prev, data]);
    };

    eventSource.onerror = () => {
      setError('Connection error. Please try again.');
      setIsLoading(false);
      eventSource.close();
    };
  }, []);

  return { events, report, error, isLoading, startAnalysis };
}
```

---

## 9. 配置与环境变量

### 9.1 环境变量

```bash
# .env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx  # Required: GitHub PAT
NITRO_PORT=3000                         # Optional: default 3000
```

### 9.2 GitHub Token 权限要求

最小权限范围：
- `read:user` — 读取用户基本信息
- `public_repo` — 读取公开仓库、事件、stars

---

## 10. 错误处理策略

### 10.1 错误分类

| 错误类型 | HTTP 状态码 | 用户消息 | 处理策略 |
|----------|-------------|----------|----------|
| 用户不存在 | 404 | "未找到该 GitHub 用户" | 直接返回 |
| API 限流 | 403 | "服务繁忙，请稍后再试" | 等待后重试 |
| 网络错误 | 网络层 | "网络异常，请检查网络" | 重试 2 次 |
| 分析超时 | N/A | "分析超时，请重试" | 强制终止 |
| 服务端错误 | 500 | "服务异常，请稍后再试" | 记录日志 |

### 10.2 重试策略

```typescript
// Exponential backoff with jitter
const retryDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
const jitter = Math.random() * 1000;
await sleep(retryDelay + jitter);
```

---

## 11. 性能考量

### 11.1 API 调用优化

- **并行请求**：Profile/Repos/Events/Stars 可并行获取的场景（需评估 GitHub 限流策略）
- **分页限制**：单次最多获取 500 条记录（5 页 × 100）
- **数据缓存**：同一请求内不缓存，依赖 GitHub 内部缓存

### 11.2 内存管理

- **流式处理**：SSE 边收边发，不积累大对象
- **状态清理**：Reactor 完成后立即释放上下文引用
- **事件数组上限**：单用户最多处理 10000 条事件，超出截断

---

## 12. 部署配置

### 12.1 Vercel

```json
// vercel.json
{
  "builds": [{ "src": "package.json", "use": "@vercel/nitro" }],
  "routes": [{ "src": "/api/(.*)", "dest": "/api/analyze" }]
}
```

### 12.2 Cloudflare Workers

Nitro Cloudflare preset 支持零配置部署：
```bash
# nitro.config.ts
export default defineNitroConfig({
  preset: 'cloudflare-pages'
});
```

---

## 13. 目录结构约定

| 目录 | 内容 |
|------|------|
| `src/app/` | VitePlus 前端入口 |
| `src/server/agent/` | ReAct Agent 核心逻辑 |
| `src/server/agent/tools/` | GitHub API 工具集 |
| `src/server/lib/` | 服务端工具库 |
| `src/shared/` | 跨端类型定义 |
