import type { GitHubEvent, GitHubEventType } from '~/shared/types';
import { GitHubClient } from './github';
import { fetchAllPages } from './fetch-pages';

export async function getUserEvents(
  client: GitHubClient,
  input: { username: string }
): Promise<GitHubEvent[]> {
  const rawData = await fetchAllPages(client, `/users/${input.username}/events`, { maxPages: 10, perPage: 100 });
  return rawData.map((item: any) => ({
    id: item.id,
    type: item.type as GitHubEventType,
    repo: { name: item.repo?.name || '', url: item.repo?.url || '' },
    payload: item.payload || {},
    createdAt: item.created_at
  }));
}
