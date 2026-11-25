import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedFile } from "../types/index.js";
import { createParserForFile } from "./core.js";
import { getAdapterForFile } from "./languages/registry.js";

export function normalizeRelativePath(repoRoot: string, targetFilePath: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedFile = path.isAbsolute(targetFilePath)
    ? path.resolve(targetFilePath)
    : path.resolve(resolvedRoot, targetFilePath);

  const relative = path.relative(resolvedRoot, resolvedFile);
  return relative.split(path.sep).join("/");
}

export async function parseSourceCode(
  sourceCode: string,
  relativeFilePath: string
): Promise<ParsedFile> {
  const normalizedPath = relativeFilePath.split("\\").join("/");
  const parser = await createParserForFile(normalizedPath);
  const adapter = getAdapterForFile(normalizedPath);
  const tree = parser.parse(sourceCode);

  if (!tree) {
    parser.delete();
    throw new Error(`Tree-sitter returned null syntax tree for "${normalizedPath}"`);
  }

  try {
    const rootNode = tree.rootNode;
    const { imports, functions } = adapter.extract(rootNode);

    return {
      file_path: normalizedPath,
      language: adapter.id,
      has_syntax_error: rootNode.hasError,
      imports,
      functions,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}

export async function parseSourceFile(
  repoRoot: string,
  targetFilePath: string
): Promise<ParsedFile> {
  const resolvedRoot = path.resolve(repoRoot);
  const absoluteFilePath = path.isAbsolute(targetFilePath)
    ? path.resolve(targetFilePath)
    : path.resolve(resolvedRoot, targetFilePath);

  const sourceCode = await fs.readFile(absoluteFilePath, "utf-8");
  const relativeFilePath = normalizeRelativePath(resolvedRoot, absoluteFilePath);

  return parseSourceCode(sourceCode, relativeFilePath);
}
