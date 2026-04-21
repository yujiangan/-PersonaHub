import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { getUserEvents } from "~/server/agent/tools/get-events";

vi.mock("~/server/agent/tools/fetch-pages");

describe("getUserEvents", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should transform raw event data correctly", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: "123456",
        type: "PushEvent",
        repo: { name: "testuser/repo", url: "https://api.github.com/repos/testuser/repo" },
        payload: { commits: [{ sha: "abc" }] },
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserEvents(mockClient, { username: "testuser" });

    expect(result).toEqual([
      {
        id: "123456",
        type: "PushEvent",
        repo: { name: "testuser/repo", url: "https://api.github.com/repos/testuser/repo" },
        payload: { commits: [{ sha: "abc" }] },
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);
  });

  it("should handle missing repo data", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: "123456",
        type: "CreateEvent",
        repo: null,
        payload: {},
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserEvents(mockClient, { username: "testuser" });

    expect(result[0].repo).toEqual({ name: "", url: "" });
  });

  it("should handle empty payload", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: "123456",
        type: "WatchEvent",
        repo: { name: "test/repo", url: "" },
        payload: undefined,
        created_at: "2024-01-01T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserEvents(mockClient, { username: "testuser" });

    expect(result[0].payload).toEqual({});
  });

  it("should transform multiple events with different types", async () => {
    const { fetchAllPages } = await import("~/server/agent/tools/fetch-pages");
    vi.mocked(fetchAllPages).mockResolvedValue([
      {
        id: "1",
        type: "PushEvent",
        repo: { name: "a/b", url: "" },
        payload: {},
        created_at: "2024-01-01T00:00:00Z",
      },
      {
        id: "2",
        type: "ForkEvent",
        repo: { name: "c/d", url: "" },
        payload: {},
        created_at: "2024-01-02T00:00:00Z",
      },
      {
        id: "3",
        type: "CreateEvent",
        repo: { name: "e/f", url: "" },
        payload: {},
        created_at: "2024-01-03T00:00:00Z",
      },
    ]);

    const mockClient = {} as any;
    const result = await getUserEvents(mockClient, { username: "testuser" });

    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("PushEvent");
    expect(result[1].type).toBe("ForkEvent");
    expect(result[2].type).toBe("CreateEvent");
  });
});
