import type { CodeMapNode, DetectedProjectInfo, ParsedFile } from "../types/index.js";
import { parseSourceFile } from "./astReader.js";
import { buildCodeMap } from "./callGraph.js";
import { detectProjectInfo } from "./projectDetector.js";
import { filterExistingSourceFiles, scanRepositoryFiles } from "./scanner.js";

export { parseSourceCode, parseSourceFile, normalizeRelativePath } from "./astReader.js";
export { buildCodeMap, type BuildCodeMapOptions } from "./callGraph.js";
export {
  initTreeSitter,
  loadLanguage,
  loadLanguageForFile,
  createParserForFile,
  getSupportedExtensions,
  isSupportedSourceFile,
  resolveGrammarForFile,
} from "./core.js";
export { getAdapterForFile, getAdapterForGrammar } from "./languages/registry.js";
export { detectProjectInfo } from "./projectDetector.js";
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
  projectInfo: DetectedProjectInfo;
  parsedFiles: ParsedFile[];
  codeMap: CodeMapNode[];
  fullCodeMap: CodeMapNode[];
}

export async function analyzeRepositoryToCodeMap(
  repoRoot: string,
  changedFiles: string[] = []
): Promise<RepositoryCodeMapResult> {
  const allSourceFiles = await scanRepositoryFiles(repoRoot);
  const projectInfo = await detectProjectInfo(repoRoot, allSourceFiles);

  // Always build call graph with full repository symbol context so cross-file calls resolve accurately
  const allParsedFiles: ParsedFile[] = [];
  for (const relativePath of allSourceFiles) {
    const parsed = await parseSourceFile(repoRoot, relativePath);
    allParsedFiles.push(parsed);
  }

  const fullCodeMap = buildCodeMap(allParsedFiles, {
    pathAliases: projectInfo.path_aliases,
  });

  if (changedFiles.length === 0) {
    return {
      projectInfo,
      parsedFiles: allParsedFiles,
      codeMap: fullCodeMap,
      fullCodeMap,
    };
  }

  const validChanged = new Set(await filterExistingSourceFiles(repoRoot, changedFiles));
  const filteredParsed = allParsedFiles.filter((f) => validChanged.has(f.file_path));
  const filteredCodeMap = fullCodeMap.filter((node) => validChanged.has(node.file_path));

  return {
    projectInfo,
    parsedFiles: filteredParsed,
    codeMap: filteredCodeMap,
    fullCodeMap,
  };
}
