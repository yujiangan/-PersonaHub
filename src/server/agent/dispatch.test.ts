import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeTool, TOOL_HANDLERS } from './dispatch';
import type { ToolContext } from './dispatch';
import type { GitHubUser } from '~/shared/types';
import type { SSEEmitter } from '~/server/lib/sse';

vi.mock('./tools/get-profile');
vi.mock('./tools/get-repos');
vi.mock('./tools/get-events');
vi.mock('./tools/get-stars');

describe('TOOL_HANDLERS', () => {
  const createMockContext = (): ToolContext => ({
    githubId: 'testuser',
    emitter: {
      emit: vi.fn(),
    } as unknown as SSEEmitter,
    githubClient: {
      fetch: vi.fn(),
    } as any,
    agentCtx: {
      githubId: 'testuser',
      profile: null,
      repos: [],
      events: [],
      stars: [],
    },
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should have handlers for all expected tools', () => {
    expect(TOOL_HANDLERS).toHaveProperty('get_user_profile');
    expect(TOOL_HANDLERS).toHaveProperty('get_user_repos');
    expect(TOOL_HANDLERS).toHaveProperty('get_user_events');
    expect(TOOL_HANDLERS).toHaveProperty('get_user_stars');
  });
});

describe('executeTool', () => {
  const createMockContext = (): ToolContext => ({
    githubId: 'testuser',
    emitter: {
      emit: vi.fn(),
    } as unknown as SSEEmitter,
    githubClient: {
      fetch: vi.fn(),
    } as any,
    agentCtx: {
      githubId: 'testuser',
      profile: null as unknown as GitHubUser,
      repos: [],
      events: [],
      stars: [],
    },
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should return error for unknown tool', async () => {
    const context = createMockContext();
    const result = await executeTool('unknown_tool', { username: 'test' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('should call correct handler for get_user_profile', async () => {
    const { getUserProfile } = await import('./tools/get-profile');
    vi.mocked(getUserProfile).mockResolvedValue({
      login: 'testuser',
      avatarUrl: '',
      bio: null,
      publicRepos: 0,
      followers: 0,
      following: 0,
      createdAt: '',
    });

    const context = createMockContext();
    const result = await executeTool('get_user_profile', { username: 'testuser' }, context);

    expect(result.success).toBe(true);
    expect(result.result).toHaveProperty('login', 'testuser');
    expect(getUserProfile).toHaveBeenCalled();
  });

  it('should return error when handler throws', async () => {
    const { getUserProfile } = await import('./tools/get-profile');
    vi.mocked(getUserProfile).mockRejectedValue(new Error('API Error'));

    const context = createMockContext();
    const result = await executeTool('get_user_profile', { username: 'testuser' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('API Error');
  });
});
