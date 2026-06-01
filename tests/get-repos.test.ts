import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { getUserRepos } from "~/server/agent/tools/get-repos";

vi.mock("~/server/agent/tools/fetch-pages");

describe("getUserRepos", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should transform raw repo data correctly", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: 123,
        name: "my-repo",
        full_name: "testuser/my-repo",
        description: "A test repository",
        language: "TypeScript",
        stargazers_count: 100,
        forks_count: 20,
        topics: ["typescript", "node"],
        fork: false,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-06-01T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserRepos(mockClient, { username: "testuser" });

    expect(result).toEqual([
      {
        id: 123,
        name: "my-repo",
        fullName: "testuser/my-repo",
        description: "A test repository",
        language: "TypeScript",
        stargazersCount: 100,
        forksCount: 20,
        topics: ["typescript", "node"],
        fork: false,
        createdAt: "2020-01-01T00:00:00Z",
        updatedAt: "2020-06-01T00:00:00Z",
      },
    ]);
  });

  it("should handle empty topics array", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: 1,
        name: "repo",
        full_name: "user/repo",
        description: null,
        language: null,
        stargazers_count: 0,
        forks_count: 0,
        topics: [],
        fork: false,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserRepos(mockClient, { username: "testuser" });

    expect(result[0].topics).toEqual([]);
  });

  it("should handle undefined topics", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: 1,
        name: "repo",
        full_name: "user/repo",
        description: null,
        language: null,
        stargazers_count: 0,
        forks_count: 0,
        topics: undefined,
        fork: false,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserRepos(mockClient, { username: "testuser" });

    expect(result[0].topics).toEqual([]);
  });

  it("should transform multiple repos", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: 1,
        name: "repo1",
        full_name: "user/repo1",
        description: null,
        language: "JS",
        stargazers_count: 5,
        forks_count: 1,
        topics: [],
        fork: false,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2020-01-01T00:00:00Z",
      },
      {
        id: 2,
        name: "repo2",
        full_name: "user/repo2",
        description: null,
        language: "TS",
        stargazers_count: 10,
        forks_count: 2,
        topics: [],
        fork: true,
        created_at: "2020-02-01T00:00:00Z",
        updated_at: "2020-02-01T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserRepos(mockClient, { username: "testuser" });

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("repo1");
    expect(result[1].fork).toBe(true);
  });
});
