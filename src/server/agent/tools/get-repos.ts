import type { GitHubRepo } from '~/shared/types';
import { GitHubClient } from './github';
import { fetchAllPages } from './fetch-pages';

export async function getUserRepos(
  client: GitHubClient,
  input: { username: string }
): Promise<GitHubRepo[]> {
  const rawData = await fetchAllPages(client, `/users/${input.username}/repos`, { maxPages: 5, perPage: 100 });
  return rawData.map((item: any) => ({
    id: item.id,
    name: item.name,
    fullName: item.full_name,
    description: item.description,
    language: item.language,
    stargazersCount: item.stargazers_count,
    forksCount: item.forks_count,
    topics: item.topics || [],
    fork: item.fork,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  }));
}
