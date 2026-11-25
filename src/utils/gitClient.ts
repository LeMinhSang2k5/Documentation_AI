import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GITHUB_REPO_PATH_RE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/;

export interface ParsedGithubRepo {
  owner: string;
  repo: string;
  normalizedUrl: string;
}

export interface ClonedRepositoryInfo {
  repoDir: string;
  branch: string;
  commitSha: string;
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

/**
 * Clone nông (shallow clone) một repository GitHub công khai vào thư mục targetDir.
 * Sử dụng execFile("git", [...]) để tránh hoàn toàn shell injection.
 * Nếu nhánh yêu cầu (vd "main") không tồn tại trên remote, tự động fallback sang nhánh mặc định của repo.
 */
export async function cloneGithubRepository(
  rawRepoUrl: string,
  targetDir: string,
  requestedBranch?: string
): Promise<ClonedRepositoryInfo> {
  const safeRepo = parseSafeGithubRepoUrl(rawRepoUrl);
  if (!safeRepo) {
    throw new Error(`Unsupported or unsafe GitHub repository URL: ${rawRepoUrl}`);
  }

  const cloneUrl = `${safeRepo.normalizedUrl}.git`;
  const resolvedTarget = path.resolve(targetDir);
  await fs.rm(resolvedTarget, { recursive: true, force: true });
  await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });

  const trimmedBranch = requestedBranch?.trim();
  const hasValidBranch =
    Boolean(trimmedBranch) &&
    SAFE_BRANCH_RE.test(trimmedBranch!) &&
    !trimmedBranch!.startsWith("-") &&
    !trimmedBranch!.includes("..");

  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };

  let cloned = false;
  if (hasValidBranch && trimmedBranch) {
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", "--single-branch", "--branch", trimmedBranch, "--", cloneUrl, resolvedTarget],
        { env: gitEnv, timeout: 60_000 }
      );
      cloned = true;
    } catch {
      // Nhánh yêu cầu có thể không tồn tại (vd repo dùng "master" thay vì "main") -> fallback sang nhánh mặc định
      await fs.rm(resolvedTarget, { recursive: true, force: true });
    }
  }

  if (!cloned) {
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--", cloneUrl, resolvedTarget],
      { env: gitEnv, timeout: 60_000 }
    );
  }

  const [{ stdout: shaOut }, { stdout: branchOut }] = await Promise.all([
    execFileAsync("git", ["-C", resolvedTarget, "rev-parse", "HEAD"], {
      env: gitEnv,
      timeout: 10_000,
    }),
    execFileAsync("git", ["-C", resolvedTarget, "rev-parse", "--abbrev-ref", "HEAD"], {
      env: gitEnv,
      timeout: 10_000,
    }),
  ]);

  return {
    repoDir: resolvedTarget,
    branch: branchOut.trim() || trimmedBranch || "main",
    commitSha: shaOut.trim(),
  };
}
