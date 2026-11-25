import type { Node } from "web-tree-sitter";
import type { ParsedFunction, ParsedImport } from "../../types/index.js";

export interface ExtractedAstData {
  imports: ParsedImport[];
  functions: ParsedFunction[];
}

export interface ImportResolveContext {
  fromFilePath: string;
  importSource: string;
  allFilePaths: Set<string>;
  pathAliases?: Record<string, string[]>;
}

export interface LanguageAdapter {
  readonly id: string;
  extract(rootNode: Node): ExtractedAstData;
  resolveImportTarget?(ctx: ImportResolveContext): string | null;
}
