#!/usr/bin/env node
/**
 * CLI xem trước tài liệu (Markdown + Mermaid) và kết quả self-check của AI Harness.
 *
 *   preview generate            -> mọi job trong data/jobs/  (+ data/jobs/index.html)
 *   preview generate <path>     -> một job: thư mục job, file result.json bất kỳ, hoặc job_id
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { docFileName, renderDocPage, renderIndexPage, summaryLine, type IndexEntry } from "./renderer.js";
import type { PreviewResult } from "./schema.js";
import { checkSchema, validateResult, type ValidationIssue, type ValidationReport } from "./validator.js";

const DEFAULT_DATA_DIR = "data/jobs";

// ---------------------------------------------------------------------------
// In ra terminal
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint("31");
const yellow = paint("33");
const green = paint("32");
const dim = paint("2");

const rel = (p: string) => {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
};

function formatIssue(i: ValidationIssue): string {
  const sev = i.severity === "error" ? red("error  ") : yellow("warning");
  const where = [i.field, i.line !== undefined ? `L${i.line}` : ""].filter(Boolean).join(":");
  const [first = "", ...rest] = i.message.split("\n");
  return [
    `    ${sev} ${dim(i.code.padEnd(20))} ${where ? dim(`${where}  `) : ""}${first}`,
    ...rest.map((l) => `${" ".repeat(14)}${dim(l)}`),
  ].join("\n");
}

function printReport(source: string, report: ValidationReport): void {
  const s = report.summary;
  console.log(`\n${source} ${dim(`— ${s.documents} doc · ${s.errors} lỗi · ${s.warnings} cảnh báo`)}`);
  console.log(`  ${dim(summaryLine(s))}`);
  report.global.forEach((i) => console.log(formatIssue(i)));
  for (const doc of report.documents) {
    const hasError = doc.issues.some((i) => i.severity === "error");
    const mark = hasError ? red("✖") : doc.issues.length ? yellow("!") : green("✔");
    const harness = doc.harness.passed ? green("harness ✔") : red("harness ✖");
    console.log(`  ${mark} ${doc.path} ${dim(`(${doc.doc_id})`)} ${harness}`);
    doc.issues.forEach((i) => console.log(formatIssue(i)));
  }
}

// ---------------------------------------------------------------------------
// Tìm & đọc job
// ---------------------------------------------------------------------------

interface JobTarget {
  /** File kết quả JSON (cùng định dạng GET /api/v1/docs/jobs/{job_id}). */
  file: string;
  /** Thư mục ghi các trang preview (với job trong data/jobs: chính thư mục job). */
  outDir: string;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Mọi <dataDir>/<job_id>/result.json, sắp theo tên. */
async function findAllJobs(dataDir: string): Promise<JobTarget[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => {
    throw new Error(`Không đọc được thư mục ${rel(dataDir)}`);
  });
  const targets: JobTarget[] = [];
  for (const e of entries.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dataDir, e.name, "result.json");
    if (await exists(file)) targets.push({ file, outDir: path.join(dataDir, e.name) });
  }
  if (targets.length === 0) throw new Error(`Không có result.json nào trong ${rel(dataDir)}`);
  return targets;
}

/**
 * result.json của job -> ghi HTML ngay cạnh nó (mỗi job đã là một thư mục riêng).
 * File JSON khác (vd experiments/results/*.json) -> .preview/<tên file>/, để không rải HTML vào thư mục được commit.
 */
function defaultOutDir(file: string): string {
  if (path.basename(file) === "result.json") return path.dirname(file);
  return path.resolve(".preview", path.basename(file, path.extname(file)));
}

/** Xoá trang HTML cũ trong outDir (không đụng result.json) và thư mục preview/ của bản CLI cũ. */
async function clearOldPages(outDir: string): Promise<void> {
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".html")) await rm(path.join(outDir, e.name));
  }
  const legacy = path.join(outDir, "preview");
  const legacyFiles = await readdir(legacy).catch(() => null);
  if (legacyFiles && legacyFiles.every((f) => f.endsWith(".html"))) await rm(legacy, { recursive: true });
}

/** <input> là thư mục job, file JSON kết quả, hoặc job_id nằm trong dataDir. */
async function resolveJob(input: string, dataDir: string, out: string | undefined): Promise<JobTarget> {
  const candidates = [path.resolve(input), path.join(dataDir, input)];
  for (const p of candidates) {
    const info = await stat(p).catch(() => null);
    if (!info) continue;
    const file = info.isDirectory() ? path.join(p, "result.json") : p;
    if (!(await exists(file))) throw new Error(`Không có result.json trong ${rel(p)}`);
    return { file, outDir: out ? path.resolve(out) : defaultOutDir(file) };
  }
  throw new Error(`Không tìm thấy job '${input}' (thử đường dẫn và ${rel(path.join(dataDir, input))})`);
}

async function loadJob(file: string): Promise<PreviewResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`${rel(file)}: JSON không hợp lệ (${err instanceof Error ? err.message : String(err)})`);
  }
  const schema = checkSchema(raw);
  if (!schema.result) {
    throw new Error([`${rel(file)}: sai định dạng kết quả`, ...schema.issues.map(formatIssue)].join("\n"));
  }
  return schema.result;
}

// ---------------------------------------------------------------------------
// Sinh preview
// ---------------------------------------------------------------------------

interface GeneratedJob {
  job: PreviewResult;
  outDir: string;
  report: ValidationReport;
}

/** Kiểm tra (gồm AI Harness self-check) rồi ghi <outDir>/<doc_id>.html + <outDir>/index.html cho một job. */
async function generateJob(target: JobTarget): Promise<GeneratedJob> {
  const job = await loadJob(target.file);
  const report = await validateResult(job);
  printReport(rel(target.file), report);

  await mkdir(target.outDir, { recursive: true });
  await clearOldPages(target.outDir);

  const reports = new Map(report.documents.map((d) => [d.doc_id, d]));
  for (const doc of job.documents) {
    const html = await renderDocPage({ job, doc, report: reports.get(doc.doc_id), jobReport: report });
    await writeFile(path.join(target.outDir, docFileName(doc.doc_id)), html, "utf8");
  }
  const index = await renderIndexPage([{ job, dir: ".", reports }]);
  await writeFile(path.join(target.outDir, "index.html"), index, "utf8");

  return { job, outDir: target.outDir, report };
}

const program = new Command();
program.name("preview").description("Sinh trang preview HTML (Markdown + Mermaid + AI Harness self-check) cho tài liệu đã sinh");

program
  .command("generate")
  .description("Sinh preview cho mọi job, hoặc chỉ một job khi truyền <path>")
  .argument("[path]", "thư mục job, file result.json, hoặc job_id (bỏ trống = mọi job trong --data)")
  .option("-d, --data <dir>", "thư mục chứa các job", DEFAULT_DATA_DIR)
  .option("-o, --out <dir>", "thư mục ghi preview (chỉ dùng khi có <path>; mặc định: thư mục job)")
  .option("--strict", "exit 1 nếu có lỗi kiểm tra (dùng cho CI)")
  .action(async (input: string | undefined, opts: { data: string; out?: string; strict?: boolean }) => {
    const dataDir = path.resolve(opts.data);
    if (opts.out && !input) throw new Error("--out chỉ dùng được khi chỉ định <path>");

    const targets = input ? [await resolveJob(input, dataDir, opts.out)] : await findAllJobs(dataDir);
    const done: GeneratedJob[] = [];
    let failed = 0;

    for (const target of targets) {
      try {
        done.push(await generateJob(target));
      } catch (err) {
        failed += 1;
        console.error(red(`✖ ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    let openPath: string;
    if (input) {
      const only = done[0];
      if (!only) throw new Error("Không sinh được preview");
      openPath = path.join(only.outDir, "index.html");
    } else {
      // Trang tổng: sidebar gom tài liệu của mọi job, link tương đối từ data/jobs/.
      const entries: IndexEntry[] = done.map(({ job, outDir, report }) => ({
        job,
        dir: path.relative(dataDir, outDir).split(path.sep).join("/"),
        reports: new Map(report.documents.map((d) => [d.doc_id, d])),
      }));
      openPath = path.join(dataDir, "index.html");
      await writeFile(openPath, await renderIndexPage(entries), "utf8");
    }

    const pages = done.reduce((n, g) => n + g.job.documents.length, 0);
    const errors = done.reduce((n, g) => n + g.report.summary.errors, 0);
    console.log(`\n${green("✔")} ${pages} trang tài liệu từ ${done.length} job → mở ${rel(openPath)}`);
    if (failed) console.log(red(`✖ ${failed} job không đọc được`));
    if (failed || (opts.strict && errors)) process.exitCode = 1;
  });

try {
  await program.parseAsync();
} catch (err) {
  console.error(red(`✖ ${err instanceof Error ? err.message : String(err)}`));
  process.exit(2);
}
