import "dotenv/config";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  analyzeRepositoryToCodeMap,
  scanRepositoryFiles,
} from "../../src/parser/index.js";
import type { CodeMapNode } from "../../src/types/index.js";
import { fileExists, readJsonFile } from "../../src/utils/fileIO.js";
import {
  cloneGithubRepository,
  parseSafeGithubRepoUrl,
} from "../../src/utils/gitClient.js";
import { logger } from "../../src/utils/logger.js";

const execFileAsync = promisify(execFile);
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, "..", "..");

export interface Week1CliOptions {
  useMock: boolean;
  localDir?: string;
  repoUrl: string;
  branch: string;
  codeMapPath?: string;
}

export interface LoadedSampleFile {
  relativePath: string;
  content: string;
  lineCount: number;
}

export function parseWeek1CliArgs(argv: string[]): Week1CliOptions {
  const args = argv.slice(2);
  let useMock = false;
  let localDir: string | undefined;
  let repoUrl =
    process.env.SAMPLE_REPO_URL ?? "https://github.com/LeMinhSang2k5/TodoAppCloud";
  let branch = process.env.SAMPLE_REPO_BRANCH ?? "master";
  let codeMapPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--mock") {
      useMock = true;
    } else if (arg === "--local-dir" && next) {
      localDir = path.resolve(next);
      i += 1;
    } else if (arg === "--repo" && next) {
      repoUrl = next;
      i += 1;
    } else if (arg === "--branch" && next) {
      branch = next;
      i += 1;
    } else if (arg === "--code-map" && next) {
      codeMapPath = path.resolve(next);
      i += 1;
    }
  }

  return { useMock, localDir, repoUrl, branch, codeMapPath };
}

export async function loadSampleRepoWithTreeSitter(
  options: Week1CliOptions,
  maxFiles: number
): Promise<{
  repoLabel: string;
  repoDir: string;
  commitSha: string;
  files: LoadedSampleFile[];
  codeMap: CodeMapNode[];
}> {
  const reposCacheDir = path.join(PROJECT_ROOT, "experiments", "repos");
  let repoDir: string;
  let commitSha = "local001";
  let repoLabel = options.repoUrl;

  if (options.localDir && (await fileExists(options.localDir))) {
    repoDir = options.localDir;
    repoLabel = options.localDir;
    commitSha = await resolveShortCommitSha(repoDir);
  } else {
    const parsedRepo = parseSafeGithubRepoUrl(options.repoUrl);
    const repoFolderName = parsedRepo?.repo ?? "sample-repo";
    const cachedDir = path.join(reposCacheDir, repoFolderName);

    if (await fileExists(path.join(cachedDir, ".git"))) {
      repoDir = cachedDir;
      commitSha = await resolveShortCommitSha(repoDir);
      logger.info("Reusing cached sample repository", { repoDir, commitSha });
    } else {
      logger.info("Cloning sample repository for Week 1 experiment", {
        repoUrl: options.repoUrl,
        branch: options.branch,
      });
      const cloned = await cloneGithubRepository(
        options.repoUrl,
        cachedDir,
        options.branch
      );
      repoDir = cloned.repoDir;
      commitSha = cloned.commitSha.slice(0, 7);
    }
  }

  const allPaths = await scanRepositoryFiles(repoDir);
  if (allPaths.length === 0) {
    throw new Error(`Không tìm thấy file mã nguồn hỗ trợ nào trong ${repoDir}`);
  }

  const loadedAll: LoadedSampleFile[] = [];
  for (const relPath of allPaths) {
    const content = await fs.readFile(path.join(repoDir, relPath), "utf-8");
    if (!content.trim()) continue;
    loadedAll.push({
      relativePath: relPath,
      content,
      lineCount: content.split(/\r?\n/).length,
    });
  }

  // Ưu tiên file giàu logic nghiệp vụ (api, hooks, services, controllers) trước dữ liệu tĩnh (data/)
  loadedAll.sort((a, b) => {
    const rank = (f: LoadedSampleFile): number => {
      if (/(?:^|\/)(?:data|constants|config|assets)\//i.test(f.relativePath)) return 3;
      if (/(?:^|\/)(?:api|services|hooks|controllers)\//i.test(f.relativePath) && f.lineCount >= 15) {
        return 0;
      }
      if (f.lineCount >= 15 && f.lineCount <= 250) return 1;
      return 2;
    };
    return rank(a) - rank(b) || b.lineCount - a.lineCount;
  });

  const selectedFiles = loadedAll.slice(0, maxFiles);

  let codeMap: CodeMapNode[];
  if (options.codeMapPath && (await fileExists(options.codeMapPath))) {
    const raw = await readJsonFile<CodeMapNode[] | { code_map: CodeMapNode[] }>(
      options.codeMapPath
    );
    codeMap = Array.isArray(raw) ? raw : raw.code_map;
  } else {
    // Dùng trực tiếp analyzeRepositoryToCodeMap (KAN-7 của Bình) để lấy đầy đủ hàm lồng nhau, path alias & liên kết calls!
    const analyzed = await analyzeRepositoryToCodeMap(
      repoDir,
      selectedFiles.map((f) => f.relativePath)
    );
    codeMap = analyzed.codeMap;
  }

  return {
    repoLabel,
    repoDir,
    commitSha,
    files: selectedFiles,
    codeMap,
  };
}

async function resolveShortCommitSha(repoDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "rev-parse", "--short=7", "HEAD"],
      { timeout: 5_000 }
    );
    return stdout.trim() || "local001";
  } catch {
    return "local001";
  }
}
