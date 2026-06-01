import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { getUserProfile } from "~/server/agent/tools/get-profile";
import { GitHubClient } from "~/server/agent/tools/github";

vi.mock("~/server/agent/tools/github");
vi.mock("~/server/agent/tools/fetch-pages");

describe("getUserProfile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should transform raw GitHub user data correctly", async () => {
    const mockClient = {
      fetch: vi.fn().mockResolvedValue({
        login: "testuser",
        avatar_url: "https://avatars.githubusercontent.com/u/123",
        bio: "A test user",
        public_repos: 10,
        followers: 100,
        following: 50,
        created_at: "2020-01-01T00:00:00Z",
      }),
    } as unknown as GitHubClient;

    const result = await getUserProfile(mockClient, { username: "testuser" });

    expect(result).toEqual({
      login: "testuser",
      avatarUrl: "https://avatars.githubusercontent.com/u/123",
      bio: "A test user",
      publicRepos: 10,
      followers: 100,
      following: 50,
      createdAt: "2020-01-01T00:00:00Z",
    });
  });

  it("should handle null bio", async () => {
    const mockClient = {
      fetch: vi.fn().mockResolvedValue({
        login: "testuser",
        avatar_url: "https://avatars.githubusercontent.com/u/123",
        bio: null,
        public_repos: 0,
        followers: 0,
        following: 0,
        created_at: "2020-01-01T00:00:00Z",
      }),
    } as unknown as GitHubClient;

    const result = await getUserProfile(mockClient, { username: "testuser" });

    expect(result.bio).toBeNull();
  });

  it("should call GitHub API with correct endpoint", async () => {
    const mockClient = {
      fetch: vi.fn().mockResolvedValue({}),
    } as unknown as GitHubClient;

    await getUserProfile(mockClient, { username: "someuser" });

    expect(mockClient.fetch).toHaveBeenCalledWith("/users/someuser");
  });
});
