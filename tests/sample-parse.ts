import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSourceFile } from "../src/parser/astReader.js";
import { buildCodeMap } from "../src/parser/callGraph.js";
import { detectProjectInfo } from "../src/parser/projectDetector.js";
import { scanRepositoryFiles } from "../src/parser/scanner.js";
import type { CodeMapNode, ParsedFile } from "../src/types/index.js";
import { writeJsonFile } from "../src/utils/fileIO.js";
import { cloneGithubRepository, parseSafeGithubRepoUrl } from "../src/utils/gitClient.js";

const DEFAULT_SAMPLE_FILES = [
  "src/api/controller.ts",
  "src/api/jobQueue.ts",
  "src/storage/jobStore.ts",
];

const DEFAULT_OUTPUT_PATH = "output/sample-parsed.json";
const DEFAULT_CODEMAP_OUTPUT_PATH = "output/sample-code-map.json";

interface CliOptions {
  repoTarget: string;
  isGithubUrl: boolean;
  branch?: string;
  files: string[];
  scanAll: boolean;
  outputPath: string;
  codeMapOutputPath: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  let repoTarget = process.cwd();
  let isGithubUrl = false;
  let branch: string | undefined;
  let outputPath = path.resolve(process.cwd(), DEFAULT_OUTPUT_PATH);
  let codeMapOutputPath = path.resolve(process.cwd(), DEFAULT_CODEMAP_OUTPUT_PATH);
  let scanAll = false;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--all") {
      scanAll = true;
      continue;
    }

    if ((arg === "--repo" || arg === "--url") && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next) {
        if (parseSafeGithubRepoUrl(next) !== null) {
          repoTarget = next;
          isGithubUrl = true;
        } else {
          repoTarget = path.resolve(next);
          isGithubUrl = false;
        }
        i += 1;
      }
      continue;
    }

    if (arg === "--branch" && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next) {
        branch = next;
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

    if (arg === "--codemap-out" && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next) {
        codeMapOutputPath = path.resolve(next);
        i += 1;
      }
      continue;
    }

    files.push(arg);
  }

  return {
    repoTarget,
    isGithubUrl,
    ...(branch ? { branch } : {}),
    files: files.length > 0 ? files : DEFAULT_SAMPLE_FILES,
    scanAll: scanAll || (isGithubUrl && files.length === 0),
    outputPath,
    codeMapOutputPath,
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

function printCodeMapSummary(codeMap: CodeMapNode[]): void {
  console.log("=".repeat(72));
  console.log(`[Code Map] Tong so node: ${codeMap.length}`);
  if (codeMap.length === 0) return;

  const rows = codeMap.map((node) => ({
    node_id: node.node_id,
    name: node.name,
    file_path: node.file_path,
    lines: `${node.start_line}-${node.end_line}`,
    calls: node.calls.length,
  }));
  console.table(rows);
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  let repoRoot = options.repoTarget;
  let tempDir: string | null = null;

  try {
    if (options.isGithubUrl) {
      tempDir = path.join(
        os.tmpdir(),
        `code-doc-sample-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
      );
      console.log(`[Tree-sitter] Cloning temporary copy of ${options.repoTarget} ...`);
      const cloned = await cloneGithubRepository(
        options.repoTarget,
        tempDir,
        options.branch
      );
      repoRoot = cloned.repoDir;
      console.log(
        `[Tree-sitter] Checked out branch "${cloned.branch}" @ ${cloned.commitSha.slice(0, 8)}`
      );
    }

    const allScannedFiles = await scanRepositoryFiles(repoRoot);
    const projectInfo = await detectProjectInfo(repoRoot, allScannedFiles);
    const targetFiles = options.scanAll ? allScannedFiles : options.files;

    console.log(`[Tree-sitter] Repo root: ${repoRoot}`);
    console.log(
      `[Tree-sitter] Detected languages: ${JSON.stringify(projectInfo.languages)} | Frameworks: ${projectInfo.frameworks.length > 0 ? projectInfo.frameworks.join(", ") : "(none)"}`
    );
    console.log(`[Tree-sitter] Parsing ${targetFiles.length} file(s)...\n`);

    const results: ParsedFile[] = [];
    for (const filePath of targetFiles) {
      const parsed = await parseSourceFile(repoRoot, filePath);
      results.push(parsed);
    }

    const codeMap = buildCodeMap(results, {
      pathAliases: projectInfo.path_aliases,
    });

    printParsedSummary(results);
    printCodeMapSummary(codeMap);

    await writeJsonFile(options.outputPath, results);
    await writeJsonFile(options.codeMapOutputPath, {
      project_info: projectInfo,
      code_map: codeMap,
    });
    console.log("=".repeat(72));
    console.log(`[OK] Da xuat ParsedFile JSON tai: ${options.outputPath}`);
    console.log(`[OK] Da xuat Code Map JSON tai:   ${options.codeMapOutputPath}`);
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((err: unknown) => {
  console.error("[ERROR] Sample parse failed:", err);
  process.exitCode = 1;
});
