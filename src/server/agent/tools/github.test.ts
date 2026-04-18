import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient } from './github';
import { GitHubError } from '~/shared/types';

describe('GitHubClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetch', () => {
    it('should return parsed JSON on successful request', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ login: 'testuser', id: 123 }),
        headers: new Map(),
        status: 200,
        statusText: 'OK',
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const client = new GitHubClient('test-token');
      const result = await client.fetch<{ login: string; id: number }>('/users/testuser');

      expect(result).toEqual({ login: 'testuser', id: 123 });
    });

    it('should throw GitHubError on 404', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
        headers: new Map(),
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const client = new GitHubClient('test-token');
      await expect(client.fetch('/users/nonexistent')).rejects.toThrow(GitHubError);
    });

    it('should throw GitHubError on rate limit exceeded (403)', async () => {
      const mockHeaders = new Map();
      mockHeaders.set('X-RateLimit-Remaining', '0');

      const mockResponse = {
        ok: false,
        status: 403,
        statusText: 'rate limit exceeded',
        json: async () => ({}),
        headers: mockHeaders,
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const client = new GitHubClient('test-token');
      await expect(client.fetch('/users/test')).rejects.toThrow('Rate limit exceeded');
    });

    it('should retry on retriable errors (500, 502, 503)', async () => {
      const mockResponse = {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
        headers: new Map(),
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const client = new GitHubClient('test-token');
      await expect(client.fetch('/users/test')).rejects.toThrow(GitHubError);
    });

    it('should include correct headers', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({}),
        headers: new Map(),
        status: 200,
        statusText: 'OK',
      };

      const fetchMock = vi.fn().mockResolvedValue(mockResponse);
      vi.stubGlobal('fetch', fetchMock);

      const client = new GitHubClient('my-token');
      await client.fetch('/users/test');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/users/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-token',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        })
      );
    });
  });
});
