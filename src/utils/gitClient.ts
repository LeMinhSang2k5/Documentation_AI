const GITHUB_REPO_PATH_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export interface ParsedGithubRepo {
  owner: string;
  repo: string;
  normalizedUrl: string;
}

/**
 * Kiểm tra chặt URL chỉ chấp nhận https://github.com/<owner>/<repo>
 * (phục vụ validate API ở Tuần 1 và git clone ở Tuần 2).
 */
export function parseSafeGithubRepoUrl(rawUrl: string): ParsedGithubRepo | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "github.com") return null;
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.pathname.includes("..")) return null;

  const match = GITHUB_REPO_PATH_RE.exec(parsed.pathname);
  if (!match) return null;

  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }

  return {
    owner,
    repo,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  };
}
