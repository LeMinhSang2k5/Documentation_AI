import path from "node:path";
import { parseSourceFile } from "../src/parser/astReader.js";
import type { ParsedFile } from "../src/types/index.js";
import { writeJsonFile } from "../src/utils/fileIO.js";

const DEFAULT_SAMPLE_FILES = [
  "src/api/controller.ts",
  "src/api/jobQueue.ts",
  "src/storage/jobStore.ts",
];

const DEFAULT_OUTPUT_PATH = "output/sample-parsed.json";

interface CliOptions {
  repoRoot: string;
  files: string[];
  outputPath: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  let repoRoot = process.cwd();
  let outputPath = path.resolve(process.cwd(), DEFAULT_OUTPUT_PATH);
  const files: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--repo" && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next) {
        repoRoot = path.resolve(next);
        i += 1;
      }
      continue;
    }

    if (arg === "--out" && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next) {
        outputPath = path.resolve(next);
        i += 1;
      }
      continue;
    }

    files.push(arg);
  }

  return {
    repoRoot,
    files: files.length > 0 ? files : DEFAULT_SAMPLE_FILES,
    outputPath,
  };
}

function printParsedSummary(results: ParsedFile[]): void {
  for (const file of results) {
    console.log("=".repeat(72));
    console.log(`File: ${file.file_path}`);
    console.log(
      `Syntax error: ${file.has_syntax_error ? "YES" : "NO"} | Imports: ${file.imports.length} | Functions/Methods: ${file.functions.length}`
    );

    if (file.functions.length === 0) {
      console.log("  (Khong tim thay ham/method nao)");
      continue;
    }

    const rows = file.functions.map((fn) => ({
      name: fn.name,
      kind: fn.kind,
      lines: `${fn.start_line}-${fn.end_line}`,
      exported: fn.is_exported,
      params: fn.params.join(", "),
      calls_count: fn.raw_calls.length,
    }));

    console.table(rows);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  console.log(`[Tree-sitter Week 1] Repo root: ${options.repoRoot}`);
  console.log(`[Tree-sitter Week 1] Parsing ${options.files.length} file(s)...\n`);

  const results: ParsedFile[] = [];
  for (const filePath of options.files) {
    const parsed = await parseSourceFile(options.repoRoot, filePath);
    results.push(parsed);
  }

  printParsedSummary(results);

  await writeJsonFile(options.outputPath, results);
  console.log("=".repeat(72));
  console.log(`[OK] Da xuat ket qua JSON tai: ${options.outputPath}`);
}

main().catch((err: unknown) => {
  console.error("[ERROR] Sample parse failed:", err);
  process.exitCode = 1;
});
