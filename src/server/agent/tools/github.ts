import { GitHubError } from '~/shared/types';

export { GitHubError } from '~/shared/types';

const REQUEST_TIMEOUT_MS = 10 * 1000;
const RETRIABLE_CODES = [403, 500, 502, 503];
const MAX_RETRIES = 2;

export class GitHubClient {
  constructor(private readonly token: string) {}

  async fetch<T>(endpoint: string): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.doFetch<T>(endpoint);
      } catch (err) {
        const isRetriable = err instanceof GitHubError && RETRIABLE_CODES.includes(err.status);
        if (attempt >= MAX_RETRIES || !isRetriable) {
          throw err;
        }
        const backoff = attempt === 0 ? 500 : 2000;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
    throw new Error('Should not reach');
  }

  private async doFetch<T>(endpoint: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };

      const url = `https://api.github.com${endpoint}`;
      const response = await fetch(url, { headers, signal: controller.signal });

      clearTimeout(timeout);

      if (response.status === 403) {
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
        if (rateLimitRemaining === '0') {
          throw new GitHubError(403, endpoint, 'Rate limit exceeded: Token quota exhausted');
        }
        throw new GitHubError(response.status, endpoint, response.statusText || 'Forbidden');
      }

      if (!response.ok) {
        throw new GitHubError(response.status, endpoint, response.statusText);
      }

      return await response.json() as T;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new GitHubError(408, endpoint, 'Request timeout');
      }
      throw err;
    }
  }
}
