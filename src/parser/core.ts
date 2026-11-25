import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

export type SupportedGrammar = "typescript" | "tsx" | "javascript" | "python" | "c_sharp";

const GRAMMAR_WASM_SPECIFIERS: Record<SupportedGrammar, string> = {
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  c_sharp: "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm",
};

const EXTENSION_TO_GRAMMAR: Record<string, SupportedGrammar> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".cs": "c_sharp",
};

export function isSupportedSourceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in EXTENSION_TO_GRAMMAR;
}

let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedGrammar, Language>();

function resolveCoreWasmPath(): string {
  return require.resolve("web-tree-sitter/tree-sitter.wasm");
}

function resolveGrammarWasmPath(grammar: SupportedGrammar): string {
  return require.resolve(GRAMMAR_WASM_SPECIFIERS[grammar]);
}

export function resolveGrammarForFile(filePath: string): SupportedGrammar {
  const ext = path.extname(filePath).toLowerCase();
  const grammar = EXTENSION_TO_GRAMMAR[ext];

  if (!grammar) {
    const supported = Object.keys(EXTENSION_TO_GRAMMAR).join(", ");
    throw new Error(
      `Unsupported file extension "${ext || "(none)"}" for "${filePath}". Supported extensions: ${supported}`
    );
  }

  return grammar;
}

export async function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    const coreWasmPath = resolveCoreWasmPath();
    initPromise = Parser.init({
      locateFile(scriptName: string, scriptDirectory: string): string {
        if (scriptName === "tree-sitter.wasm") {
          return coreWasmPath;
        }
        return path.join(scriptDirectory, scriptName);
      },
    }).catch((err: unknown) => {
      initPromise = null;
      throw err;
    });
  }

  await initPromise;
}

export async function loadLanguage(grammar: SupportedGrammar): Promise<Language> {
  await initTreeSitter();

  const cached = languageCache.get(grammar);
  if (cached) {
    return cached;
  }

  const wasmPath = resolveGrammarWasmPath(grammar);
  const language = await Language.load(wasmPath);
  languageCache.set(grammar, language);
  return language;
}

export async function loadLanguageForFile(filePath: string): Promise<Language> {
  const grammar = resolveGrammarForFile(filePath);
  return loadLanguage(grammar);
}

export async function createParserForFile(filePath: string): Promise<Parser> {
  const language = await loadLanguageForFile(filePath);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
