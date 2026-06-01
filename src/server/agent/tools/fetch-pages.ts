import { GitHubClient, GitHubError } from "./github";

interface FetchAllPagesOptions {
  maxPages?: number;
  perPage?: number;
}

export async function fetchAllPages(
  client: GitHubClient,
  baseEndpoint: string,
  options: FetchAllPagesOptions = {},
): Promise<unknown[]> {
  const { maxPages = 5, perPage = 100 } = options;
  const separator = baseEndpoint.includes("?") ? "&" : "?";

  const pageUrls = Array.from({ length: maxPages }, (_, i) => {
    const page = i + 1;
    return `${baseEndpoint}${separator}per_page=${perPage}&page=${page}`;
  });

  // Fetch all pages in parallel, but catch errors to handle pagination limits gracefully
  const responses = await Promise.all(
    pageUrls.map(async (url) => {
      try {
        return await client.fetch<unknown[]>(url);
      } catch (err) {
        // GitHub API returns 422 when pagination limit is reached
        // Treat this as an empty page rather than failing the whole request
        if (err instanceof GitHubError && err.status === 422) {
          return [];
        }
        throw err;
      }
    }),
  );

  const results: unknown[] = [];
  for (const data of responses) {
    if (Array.isArray(data) && data.length > 0) {
      results.push(...data);
    }
  }

  return results;
}
