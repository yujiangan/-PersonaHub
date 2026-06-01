import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fetchAllPages } from "~/server/agent/tools/fetch-pages";
import { GitHubClient, GitHubError } from "~/server/agent/tools/github";

describe("fetchAllPages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should fetch single page when data exists", async () => {
    const mockClient = {
      fetch: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    } as unknown as GitHubClient;

    const result = await fetchAllPages(mockClient, "/users/test/repos", { maxPages: 1 });

    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockClient.fetch).toHaveBeenCalledTimes(1);
  });

  it("should use custom maxPages and perPage options", async () => {
    const mockClient = {
      fetch: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;

    await fetchAllPages(mockClient, "/users/test/repos", { maxPages: 3, perPage: 50 });

    expect(mockClient.fetch).toHaveBeenCalledTimes(3);
  });

  it("should return empty array when all pages return 422", async () => {
    const mockClient = {
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new GitHubError(422, "/users/test/repos", "Unprocessable Entity"))
        .mockRejectedValueOnce(new GitHubError(422, "/users/test/repos", "Unprocessable Entity")),
    } as unknown as GitHubClient;

    const result = await fetchAllPages(mockClient, "/users/test/repos", { maxPages: 2 });

    expect(result).toEqual([]);
  });

  it("should rethrow non-422 errors", async () => {
    const mockClient = {
      fetch: vi.fn().mockRejectedValue(new GitHubError(500, "/users/test/repos", "Server Error")),
    } as unknown as GitHubClient;

    await expect(fetchAllPages(mockClient, "/users/test/repos", { maxPages: 1 })).rejects.toThrow(
      GitHubError,
    );
  });

  it("should handle mixed results (some pages empty)", async () => {
    const mockClient = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce([{ id: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 2 }, { id: 3 }]),
    } as unknown as GitHubClient;

    const result = await fetchAllPages(mockClient, "/users/test/repos", { maxPages: 3 });

    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("should append query params correctly when endpoint has no query string", async () => {
    const mockClient = {
      fetch: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;

    await fetchAllPages(mockClient, "/users/test/repos", { maxPages: 1 });

    expect(mockClient.fetch).toHaveBeenCalledWith("/users/test/repos?per_page=100&page=1");
  });

  it("should append query params correctly when endpoint has existing query string", async () => {
    const mockClient = {
      fetch: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubClient;

    await fetchAllPages(mockClient, "/users/test/repos?type=all", { maxPages: 1 });

    expect(mockClient.fetch).toHaveBeenCalledWith("/users/test/repos?type=all&per_page=100&page=1");
  });
});
