# PersonaHub — 设计规范

## 1. Overview

**项目名称**: PersonaHub
**类型**: AI Agent 应用（ReAct 循环 + 多轮对话 + 工具调用）
**一句话描述**: 输入任意 GitHub 用户 ID，通过分析其 timeline、contributions、stars 推断用户偏好、技术栈、当前关注领域，生成用户画像情报。
**目标用户**: HR、社工、安全研究员 — 需要快速了解某个人的技术背景和兴趣

---

## 2. 业务场景

- **社工**: 收集目标人物的上下文，了解其技术背景、关注领域
- **人才挖掘**: HR 通过 GitHub 画像寻找符合技术要求的人才
- **个人了解**: 不认识某个 GitHub 用户时，快速获取上下文

---

## 3. 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | VitePlus + React + TypeScript |
| 后端框架 | Nitro（SSR + API） |
| Agent 实现 | 纯手写 ReAct 循环（Node.js） |
| 数据源 | GitHub API（公开数据，需用户输入 Token） |
| 流式传输 | SSE（Server-Sent Events） |
| 部署目标 | Vercel / Railway / Cloudflare |

---

## 4. 架构设计

```
┌─────────────┐      SSE       ┌─────────────┐
│   前端       │  <──────────>  │   Nitro     │
│  (VitePlus) │               │   后端      │
│             │   HTTP API    │             │
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

### 4.1 前后端职责

**前端职责**:
- 搜索框输入 GitHub 用户 ID + GitHub Token
- SSE 流式接收 Agent 思考过程
- 展示最终用户画像报告
- 展示 Agent 思考过程的实时流

**后端职责**:
- Nitro API 接收请求
- ReAct Agent 执行循环
- 调用 GitHub API 工具
- SSE 推送思考过程到前端

---

## 5. ReAct Agent 设计

### 5.1 Agent 循环

```
while (not done):
    1. Think:     Agent 分析当前状态，决定下一步行动
    2. Action:   Agent 选择并调用一个工具
    3. Observe:   获取工具返回结果
    4. Stream:   推送思考过程到前端（SSE）
    5. Loop:     重复直到生成最终报告
```

### 5.2 Prompt 设计

Agent 的角色设定（System Prompt）:

```
你是一个 OSINT（开源情报）分析师，擅长通过 GitHub 数据分析人物的技术背景和兴趣。

你的任务是分析给定的 GitHub 用户，生成一份用户画像情报报告。

分析维度：
1. 基本信息（用户名、头像、ID、bio）
2. 技术领域（通过仓库和事件分析）
3. 活跃时间（timeline 分析）
4. 喜欢的技术 Top N（通过 stars + repos 分析）
5. 最近在做什么（通过 events 推断）

输出格式为结构化报告，语言简洁专业。
```

### 5.3 工具定义

| 工具名 | 参数 | 返回 | 用途 |
|--------|------|------|------|
| `getUserProfile` | `id: string` | 用户基本信息 | 第一步获取 |
| `getUserRepos` | `id: string` | 仓库列表（语言、star 数等） | 分析技术栈 |
| `getUserEvents` | `id: string` | timeline 事件 | 分析活跃时间、近期行为 |
| `getUserStars` | `id: string` | star 的仓库列表 | 分析偏好技术 |
| `getRepoDetails` | `owner, repo` | 仓库详情 | 深入分析某个仓库 |

### 5.4 思考过程流式输出

每一步 Agent 的思考内容通过 SSE 推送到前端：

```
thinking: "我需要先获取用户的基本信息..."
action: "调用 getUserProfile"
observation: "获取到用户名为 xxx，头像为 xxx..."
thinking: "现在我需要了解用户的活跃时间..."
action: "调用 getUserEvents"
...
final_report: "## 用户画像报告\n\n### 基本信息\n..."
```

---

## 6. 前端设计

### 6.1 页面结构

```
┌──────────────────────────────────────────┐
│  🔍 搜索框                                │
│  [GitHub User ID] [GitHub Token] [搜索]  │
├──────────────────────────────────────────┤
│                                          │
│  💭 Agent 思考过程（流式显示）            │
│  ┌────────────────────────────────────┐  │
│  │ 正在分析 xxx 的 GitHub 档案...      │  │
│  │ ✓ 获取到基本信息                   │  │
│  │ → 正在分析仓库列表...              │  │
│  │ ✓ 发现主要使用 Python 和 React     │  │
│  │ ...                                │  │
│  └────────────────────────────────────┘  │
│                                          │
├──────────────────────────────────────────┤
│                                          │
│  📊 用户画像报告（最终展示）             │
│  ┌────────────────────────────────────┐  │
│  │ 头像 | 用户名 | ID                 │  │
│  │                                    │  │
│  │ 技术领域: AI, Web, DevOps          │  │
│  │ 活跃时间: 工作日白天（UTC）        │  │
│  │ 喜欢的技术 Top 5:                   │  │
│  │   1. Python                        │  │
│  │   2. React                         │  │
│  │   3. TensorFlow                    │  │
│  │                                    │  │
│  │ 最近在做什么:                      │  │
│  │   正在开发 LLM 相关项目            │  │
│  └────────────────────────────────────┘  │
│                                          │
└──────────────────────────────────────────┘
```

### 6.2 UI 风格

- **风格**: 现代化仪表盘，卡片式布局
- **配色**: 浅色主题，GitHub 蓝色强调
- **思考过程**: 类似 ChatGPT 的消息流，带图标区分步骤
- **报告展示**: 卡片式信息组织，清晰分层

---

## 7. API 设计

### 7.1 端点

**POST /api/analyze**

请求:
```json
{
  "githubId": "octocat",
  "githubToken": "ghp_xxxx"
}
```

响应（SSE）:
```
data: {"type": "thinking", "content": "正在获取用户基本信息..."}
data: {"type": "action", "content": "调用 getUserProfile"}
data: {"type": "observation", "content": "获取成功，用户名: octocat"}
data: {"type": "thinking", "content": "现在我需要分析他的技术栈..."}
...
data: {"type": "final_report", "content": "## 用户画像报告\n\n..."}
data: {"type": "done", "content": ""}
```

### 7.2 错误处理

| 错误 | 响应 |
|------|------|
| GitHub Token 无效 | SSE: `{"type": "error", "content": "GitHub Token 无效"}` |
| 用户不存在 | SSE: `{"type": "error", "content": "用户不存在"}` |
| Rate Limit | SSE: `{"type": "error", "content": "API 配额已用尽，请稍后再试"}` |

---

## 8. GitHub Token 处理

- 用户在前端输入自己的 GitHub Personal Access Token
- Token 通过请求体传给后端
- Token 不持久化存储（每次请求都传递）
- 使用 HTTPS 确保传输安全

---

## 9. 实现计划

### Phase 1: 项目初始化
- 初始化 VitePlus + React + Nitro 项目
- 配置 TypeScript

### Phase 2: ReAct Agent 核心
- 实现 ReAct 循环框架
- 实现 5 个 GitHub 工具
- 实现 Prompt 模板
- 测试 Agent 循环

### Phase 3: 后端 API
- 实现 Nitro API 端点
- 集成 SSE 流式输出
- 错误处理

### Phase 4: 前端界面
- 搜索框组件
- SSE 流式显示组件
- 用户画像报告展示组件
- 样式美化

### Phase 5: 部署
- 部署到云平台
- 环境变量配置
- 验证生产环境

---

## 10. 验收标准

- [ ] 输入 GitHub 用户 ID，能获取并展示用户画像
- [ ] Agent 思考过程实时流式显示
- [ ] 5 个工具都能正常工作
- [ ] 部署到云后能正常访问
- [ ] ReAct 循环能正确处理各种边界情况
