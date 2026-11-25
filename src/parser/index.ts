import type { CodeMapNode, ParsedFile } from "../types/index.js";
import { parseSourceFile } from "./astReader.js";
import { buildCodeMap } from "./callGraph.js";
import { filterExistingSourceFiles, scanRepositoryFiles } from "./scanner.js";

export { parseSourceCode, parseSourceFile, normalizeRelativePath } from "./astReader.js";
export { buildCodeMap } from "./callGraph.js";
export { initTreeSitter, loadLanguage, loadLanguageForFile, createParserForFile } from "./core.js";
export { scanRepositoryFiles, filterExistingSourceFiles, isScannableSourceFile } from "./scanner.js";

export async function parseFiles(
  repoRoot: string,
  filePaths: string[]
): Promise<ParsedFile[]> {
  const validFiles = await filterExistingSourceFiles(repoRoot, filePaths);
  const results: ParsedFile[] = [];

  for (const relativePath of validFiles) {
    const parsed = await parseSourceFile(repoRoot, relativePath);
    results.push(parsed);
  }

  return results;
}

export async function parseRepository(repoRoot: string): Promise<ParsedFile[]> {
  const sourceFiles = await scanRepositoryFiles(repoRoot);
  const results: ParsedFile[] = [];

  for (const relativePath of sourceFiles) {
    const parsed = await parseSourceFile(repoRoot, relativePath);
    results.push(parsed);
  }

  return results;
}

export interface RepositoryCodeMapResult {
  parsedFiles: ParsedFile[];
  codeMap: CodeMapNode[];
}

export async function analyzeRepositoryToCodeMap(
  repoRoot: string,
  changedFiles: string[] = []
): Promise<RepositoryCodeMapResult> {
  const parsedFiles =
    changedFiles.length > 0
      ? await parseFiles(repoRoot, changedFiles)
      : await parseRepository(repoRoot);

  const codeMap = buildCodeMap(parsedFiles);
  return { parsedFiles, codeMap };
}
