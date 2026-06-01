import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { getUserStars } from "~/server/agent/tools/get-stars";

vi.mock("~/server/agent/tools/fetch-pages");

describe("getUserStars", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should transform raw starred repo data correctly", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: 123,
        name: "awesome-repo",
        full_name: "otheruser/awesome-repo",
        description: "An awesome repository",
        language: "Rust",
        topics: ["rust", "awesome"],
        stargazers_count: 500,
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserStars(mockClient, { username: "testuser" });

    expect(result).toEqual([
      {
        id: 123,
        name: "awesome-repo",
        fullName: "otheruser/awesome-repo",
        description: "An awesome repository",
        language: "Rust",
        topics: ["rust", "awesome"],
        stargazersCount: 500,
      },
    ]);
  });

  it("should handle empty topics", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: 1,
        name: "repo",
        full_name: "user/repo",
        description: null,
        language: null,
        topics: [],
        stargazers_count: 0,
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserStars(mockClient, { username: "testuser" });

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
        topics: undefined,
        stargazers_count: 10,
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserStars(mockClient, { username: "testuser" });

    expect(result[0].topics).toEqual([]);
  });

  it("should transform multiple starred repos", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: 1,
        name: "repo1",
        full_name: "u1/r1",
        description: "d1",
        language: "JS",
        topics: [],
        stargazers_count: 100,
      },
      {
        id: 2,
        name: "repo2",
        full_name: "u2/r2",
        description: "d2",
        language: "TS",
        topics: ["ts"],
        stargazers_count: 200,
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserStars(mockClient, { username: "testuser" });

    expect(result).toHaveLength(2);
    expect(result[0].stargazersCount).toBe(100);
    expect(result[1].topics).toEqual(["ts"]);
  });
});
