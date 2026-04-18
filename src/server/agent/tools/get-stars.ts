import type { GitHubStarredRepo } from '~/shared/types';
import { GitHubClient } from './github';
import { fetchAllPages } from './fetch-pages';

export async function getUserStars(
  client: GitHubClient,
  input: { username: string }
): Promise<GitHubStarredRepo[]> {
  const rawData = await fetchAllPages(client, `/users/${input.username}/starred`, { maxPages: 10, perPage: 100 });
  return rawData.map((item: any) => ({
    id: item.id,
    name: item.name,
    fullName: item.full_name,
    description: item.description,
    language: item.language,
    topics: item.topics || [],
    stargazersCount: item.stargazers_count
  }));
}
