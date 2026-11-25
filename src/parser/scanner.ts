import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "./astReader.js";
import { isSupportedSourceFile } from "./core.js";

const IGNORED_DIRS = new Set([
  ".git",
  ".github",
  ".vscode",
  ".idea",
  ".next",
  ".nuxt",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "public",
  "doc",
  "docs",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "env",
  "site-packages",
  "bin",
  "obj",
  "target",
  "vendor",
  ".gradle",
]);

const IGNORED_FILE_PATTERNS = [
  /\.d\.ts$/i,
  /\.test\.[^.]+$/i,
  /\.spec\.[^.]+$/i,
  /^test_.*\.py$/i,
  /_test\.py$/i,
  /_test\.go$/i,
  /Tests?\.cs$/i,
  /Tests?\.java$/i,
  /\.min\.js$/i,
  /\.config\.[^.]+$/i,
];

export function isScannableSourceFile(relativePath: string): boolean {
  const normalized = relativePath.split("\\").join("/");
  const segments = normalized.split("/");
  if (segments.some((seg) => IGNORED_DIRS.has(seg))) {
    return false;
  }

  const baseName = path.posix.basename(normalized);
  if (!isSupportedSourceFile(baseName)) {
    return false;
  }

  return !IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(baseName));
}

export async function scanRepositoryFiles(repoRoot: string): Promise<string[]> {
  const resolvedRoot = path.resolve(repoRoot);
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      const absPath = path.join(currentDir, entry.name);
      const relPath = normalizeRelativePath(resolvedRoot, absPath);
      if (isScannableSourceFile(relPath)) {
        results.push(relPath);
      }
    }
  }

  await walk(resolvedRoot);
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

export async function filterExistingSourceFiles(
  repoRoot: string,
  filePaths: string[]
): Promise<string[]> {
  const resolvedRoot = path.resolve(repoRoot);
  const matched: string[] = [];

  for (const rawPath of filePaths) {
    const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!isScannableSourceFile(normalized)) continue;

    const absPath = path.resolve(resolvedRoot, normalized);
    if (!absPath.startsWith(resolvedRoot + path.sep) && absPath !== resolvedRoot) {
      continue;
    }

    try {
      const stat = await fs.stat(absPath);
      if (stat.isFile()) {
        matched.push(normalizeRelativePath(resolvedRoot, absPath));
      }
    } catch {
      // File may have been deleted in the commit
    }
  }

  return Array.from(new Set(matched)).sort((a, b) => a.localeCompare(b));
}
