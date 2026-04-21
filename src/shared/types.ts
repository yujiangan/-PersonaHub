export interface GitHubUser {
  login: string;
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

export interface GitHubEvent {
  id: string;
  type: GitHubEventType;
  repo: { name: string; url: string };
  payload: Record<string, unknown>;
  createdAt: string;
}

export type GitHubEventType =
  | "PushEvent"
  | "CreateEvent"
  | "DeleteEvent"
  | "IssuesEvent"
  | "PullRequestEvent"
  | "IssueCommentEvent"
  | "PullRequestReviewEvent"
  | "ForkEvent"
  | "WatchEvent"
  | "ReleaseEvent"
  | "CommitCommentEvent";

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
  type: SSEEventType;
  content: string;
  timestamp: number;
}

export type SSEEventType =
  | "thinking"
  | "observation"
  | "step"
  | "tool_start"
  | "tool_end"
  | "final_report"
  | "error"
  | "done";

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentContext {
  githubId: string;
  profile: GitHubUser | null;
  repos: GitHubRepo[];
  events: GitHubEvent[];
  stars: GitHubStarredRepo[];
}
