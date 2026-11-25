import { resolveGrammarForFile, type SupportedGrammar } from "../core.js";
import { csharpAdapter } from "./csharp.js";
import { createGenericAdapter } from "./generic.js";
import { pythonAdapter } from "./python.js";
import type { LanguageAdapter } from "./types.js";
import { typescriptAdapter } from "./typescript.js";

const ADAPTER_BY_GRAMMAR: Record<SupportedGrammar, LanguageAdapter> = {
  typescript: typescriptAdapter,
  tsx: typescriptAdapter,
  javascript: typescriptAdapter,
  python: pythonAdapter,
  c_sharp: csharpAdapter,
  java: createGenericAdapter("java"),
  go: createGenericAdapter("go"),
  php: createGenericAdapter("php"),
  rust: createGenericAdapter("rust"),
  ruby: createGenericAdapter("ruby"),
  kotlin: createGenericAdapter("kotlin"),
  cpp: createGenericAdapter("cpp"),
  c: createGenericAdapter("c"),
};

export function getAdapterForGrammar(grammar: SupportedGrammar): LanguageAdapter {
  return ADAPTER_BY_GRAMMAR[grammar];
}

export function getAdapterForFile(filePath: string): LanguageAdapter {
  const grammar = resolveGrammarForFile(filePath);
  return ADAPTER_BY_GRAMMAR[grammar];
}

export type { ExtractedAstData, ImportResolveContext, LanguageAdapter } from "./types.js";
