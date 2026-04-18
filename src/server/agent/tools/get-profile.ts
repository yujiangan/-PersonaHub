import type { GitHubUser } from '~/shared/types';
import { GitHubClient } from './github';

interface GitHubUserRaw {
  login: string;
  avatar_url: string;
  bio: string | null;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
}

export async function getUserProfile(
  client: GitHubClient,
  input: { username: string }
): Promise<GitHubUser> {
  const data = await client.fetch<GitHubUserRaw>(`/users/${input.username}`);
  return {
    login: data.login,
    avatarUrl: data.avatar_url,
    bio: data.bio,
    publicRepos: data.public_repos,
    followers: data.followers,
    following: data.following,
    createdAt: data.created_at
  };
}
