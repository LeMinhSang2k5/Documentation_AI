import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_STRUCTURED_JSON_PROMPT,
  generateDocumentWithSelfCheck,
  LLMClient,
  MetricsTracker,
  type LLMProviderName,
} from "../ai_harness/index.js";
import {
  analyzeRepositoryToCodeMap,
  groupFilesByBusinessFeature,
} from "../parser/index.js";
import type { LocalFileStorage } from "../storage/fileStorage.js";
import type { JobStore } from "../storage/jobStore.js";
import type {
  AnalyzeRequest,
  CodeMapNode,
  DetectedProjectInfo,
  DocItem,
  LocalJobResult,
  ParsedFile,
  SampleOutputData,
} from "../types/index.js";
import { fileExists, readJsonFile } from "../utils/fileIO.js";
import { cloneGithubRepository } from "../utils/gitClient.js";
import { logger } from "../utils/logger.js";

export interface JobQueue {
  enqueue(jobId: string, payload: AnalyzeRequest): void;
}

export interface MockJobQueueOptions {
  delayMs?: number;
  sampleFilePath?: string;
}

export class MockJobQueue implements JobQueue {
  private readonly delayMs: number;
  private readonly sampleFilePath: string;

  constructor(
    private readonly jobStore: JobStore,
    private readonly fileStorage: LocalFileStorage,
    options: MockJobQueueOptions = {}
  ) {
    this.delayMs = options.delayMs ?? 2000;
    this.sampleFilePath =
      options.sampleFilePath ?? path.resolve(process.cwd(), "src", "data", "sample-output.json");
  }

  enqueue(jobId: string, payload: AnalyzeRequest): void {
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      void this.processMockJob(jobId, payload, startedAt);
    }, this.delayMs);

    timer.unref?.();
  }

  private async resolveMockSamplePath(): Promise<string> {
    if (await fileExists(this.sampleFilePath)) {
      return this.sampleFilePath;
    }
    const fallback = path.resolve(
      process.cwd(),
      "experiments",
      "results",
      "sample_for_group_2_2.json"
    );
    if (await fileExists(fallback)) {
      return fallback;
    }
    return this.sampleFilePath;
  }

  private async processMockJob(
    jobId: string,
    payload: AnalyzeRequest,
    startedAt: number
  ): Promise<void> {
    try {
      const samplePath = await this.resolveMockSamplePath();
      const sample = await readJsonFile<SampleOutputData>(samplePath);
      const resolvedCommitSha = payload.commit_sha ?? sample.commit_sha;

      const resultPayload: LocalJobResult = {
        job_id: jobId,
        status: "done",
        commit_sha: resolvedCommitSha,
        code_map: sample.code_map,
        documents: sample.documents,
      };

      const resultPath = await this.fileStorage.saveJobResult(jobId, resultPayload);

      await this.jobStore.update(jobId, {
        status: "done",
        commit_sha: resolvedCommitSha,
        result_path: resultPath,
        code_map: sample.code_map,
        documents: sample.documents,
        metadata: {
          pipeline_mode: "week1_mock",
          duration_ms: Date.now() - startedAt,
          changed_files_count: payload.changed_files.length,
        },
        error: null,
      });

      logger.info("Job completed successfully", { job_id: jobId, result_path: resultPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected background processing error";
      logger.error("Background job failed", { job_id: jobId, reason: message });

      try {
        await this.jobStore.update(jobId, {
          status: "failed",
          error: {
            code: "JOB_PROCESSING_FAILED",
            message,
          },
        });
      } catch (updateErr) {
        logger.error("Failed to persist failed status to JobStore", {
          job_id: jobId,
          reason: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
    }
  }
}

export interface TreeSitterJobQueueOptions {
  reposBaseDir?: string;
  keepClonedRepo?: boolean;
  llmProvider?: LLMProviderName;
  maxModuleDocs?: number;
  maxNodesPerDoc?: number;
  interDocDelayMs?: number;
}

interface ModuleGroup {
  moduleKey: string;
  baseSlug: string;
  docId: string;
  docPath: string;
  targetLabel: string;
  files: ParsedFile[];
  nodes: CodeMapNode[];
}

const MAX_SOURCE_CHARS_PER_DOC = 18_000;
const DEFAULT_MAX_NODES_PER_DOC = 60;

function slugifyId(input: string): string {
  return input
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Xác định khóa module thông minh cho cả repo đơn lẫn monorepo (Java/Spring, React, Python, C#).
 * VD:
 * - `QuitSmoking_BE/quitsmoking/src/main/java/com/quitsmoking/controllers/AuthController.java` -> `QuitSmoking_BE/controllers`
 * - `Frontend/src/components/NewsCard.jsx` -> `Frontend/src/components`
 * - `src/api/controller.ts` -> `src/api`
 */
function resolveModuleKey(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "root";

  // Java / Kotlin / Maven / Gradle layout: <prefix>/src/main/(java|kotlin)/<group>/<artifact>/<layer>/...
  const javaIdx = parts.findIndex(
    (p, idx) =>
      (p === "java" || p === "kotlin") &&
      idx >= 2 &&
      parts[idx - 1] === "main" &&
      parts[idx - 2] === "src"
  );
  if (javaIdx !== -1) {
    const prefix = javaIdx >= 3 ? parts[0]! : "java";
    // Bỏ qua 2 segment package gốc (vd com/quitsmoking) nếu phía sau còn thư mục layer (controllers, services, ...)
    const afterJava = parts.slice(javaIdx + 1, -1);
    const layer =
      afterJava.length >= 3
        ? afterJava[2]!
        : afterJava[afterJava.length - 1] ?? "core";
    return `${prefix}/${layer}`;
  }

  // Monorepo hoặc repo chuẩn có thư mục `src/` hoặc `server/` hoặc `app/`
  const srcIdx = parts.findIndex((p) => p === "src" || p === "server" || p === "app");
  if (srcIdx !== -1 && srcIdx + 2 < parts.length) {
    const prefix = srcIdx > 0 ? `${parts[0]}/${parts[srcIdx]}` : parts[srcIdx]!;
    return `${prefix}/${parts[srcIdx + 1]}`;
  }

  if (parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0]!;
}

/**
 * Chia nhỏ một module bucket thành các batch tối đa `maxNodesPerDoc` node
 * để không bao giờ nhồi hàng trăm/nghìn node code_map vào 1 prompt LLM duy nhất.
 */
function splitBucketByMaxNodes(
  moduleKey: string,
  groupFiles: ParsedFile[],
  codeMap: CodeMapNode[],
  maxNodesPerDoc: number
): ModuleGroup[] {
  const nodesByFile = new Map<string, CodeMapNode[]>();
  for (const node of codeMap) {
    const list = nodesByFile.get(node.file_path) ?? [];
    list.push(node);
    nodesByFile.set(node.file_path, list);
  }

  const rawChunks: Array<{ files: ParsedFile[]; nodes: CodeMapNode[] }> = [];
  let currentFiles: ParsedFile[] = [];
  let currentNodes: CodeMapNode[] = [];

  for (const file of groupFiles) {
    const fileNodes = nodesByFile.get(file.file_path) ?? [];

    // Trường hợp hiếm: bản thân 1 file đơn lẻ đã có > maxNodesPerDoc node -> cắt lát theo maxNodesPerDoc
    if (fileNodes.length > maxNodesPerDoc) {
      if (currentFiles.length > 0) {
        rawChunks.push({ files: currentFiles, nodes: currentNodes });
        currentFiles = [];
        currentNodes = [];
      }
      for (let offset = 0; offset < fileNodes.length; offset += maxNodesPerDoc) {
        rawChunks.push({
          files: [file],
          nodes: fileNodes.slice(offset, offset + maxNodesPerDoc),
        });
      }
      continue;
    }

    if (currentFiles.length > 0 && currentNodes.length + fileNodes.length > maxNodesPerDoc) {
      rawChunks.push({ files: currentFiles, nodes: currentNodes });
      currentFiles = [];
      currentNodes = [];
    }

    currentFiles.push(file);
    currentNodes.push(...fileNodes);
  }

  if (currentFiles.length > 0) {
    rawChunks.push({ files: currentFiles, nodes: currentNodes });
  }

  const baseSlug = slugifyId(moduleKey) || "core";
  return rawChunks.map((chunk, idx) => {
    const isMultiPart = rawChunks.length > 1;
    const partSuffix = isMultiPart ? `_part${idx + 1}` : "";
    const labelSuffix = isMultiPart ? ` (phần ${idx + 1}/${rawChunks.length})` : "";
    return {
      moduleKey,
      baseSlug,
      docId: `doc_module_${baseSlug}${partSuffix}`,
      docPath: `modules/${baseSlug}${partSuffix}.md`,
      targetLabel: `${moduleKey}${labelSuffix}`,
      files: chunk.files,
      nodes: chunk.nodes,
    };
  });
}

/**
 * Chấm điểm mức độ quan trọng của từng module dựa hoàn toàn trên cấu trúc Call Graph (`code_map`),
 * KHÔNG hard-code tên thư mục hay framework:
 * - Module chứa logic/luồng xử lý chính có nhiều cạnh `calls` (in + out) và nhiều hàm logic (>= 8 dòng).
 * - Module chỉ chứa DTO/Entity/Getter-Setter thường có `calls` ~ 0 và hàm rất ngắn (1–3 dòng).
 */
function computeModuleImportanceScore(
  moduleNodes: CodeMapNode[],
  inDegreeMap: Map<string, number>
): number {
  let outCalls = 0;
  let inCalls = 0;
  let substantialFunctions = 0;

  for (const node of moduleNodes) {
    outCalls += node.calls.length;
    inCalls += inDegreeMap.get(node.node_id) ?? 0;
    const lineCount = node.end_line - node.start_line + 1;
    if (lineCount >= 8) {
      substantialFunctions += 1;
    }
  }

  return (outCalls + inCalls) * 3 + substantialFunctions;
}

function groupFilesForDocumentation(
  parsedFiles: ParsedFile[],
  codeMap: CodeMapNode[],
  maxModuleDocs: number,
  maxNodesPerDoc: number = DEFAULT_MAX_NODES_PER_DOC
): ModuleGroup[] {
  if (parsedFiles.length === 0) return [];

  // Nếu chỉ quét <= 6 file (VD: truyền changed_files 1–5 file hoặc repo nhỏ) -> viết 1 tài liệu chi tiết cho từng file
  if (parsedFiles.length <= 6) {
    const fileGroups: ModuleGroup[] = [];
    for (const file of parsedFiles) {
      const fileNodes = codeMap.filter((n) => n.file_path === file.file_path);
      if (fileNodes.length > maxNodesPerDoc) {
        fileGroups.push(...splitBucketByMaxNodes(file.file_path, [file], fileNodes, maxNodesPerDoc));
        continue;
      }
      const baseSlug = slugifyId(file.file_path) || "module";
      const fileName = path.posix.basename(file.file_path, path.posix.extname(file.file_path));
      const dirPart = path.posix.dirname(file.file_path);
      const docRelPath =
        dirPart && dirPart !== "." ? `modules/${dirPart}/${fileName}.md` : `modules/${fileName}.md`;

      fileGroups.push({
        moduleKey: file.file_path,
        baseSlug,
        docId: `doc_${baseSlug}`,
        docPath: docRelPath,
        targetLabel: file.file_path,
        files: [file],
        nodes: fileNodes,
      });
    }
    return fileGroups.slice(0, maxModuleDocs);
  }

  // Tính in-degree trên toàn bộ code_map để đo mức độ trung tâm của từng module
  const inDegreeMap = new Map<string, number>();
  for (const node of codeMap) {
    for (const targetId of node.calls) {
      inDegreeMap.set(targetId, (inDegreeMap.get(targetId) ?? 0) + 1);
    }
  }

  // Gom file theo Chức năng nghiệp vụ (Feature-based qua Call Graph + Domain Stem, mặc định)
  // hoặc theo thư mục nếu đặt DOC_GROUPING_MODE=folder trong .env
  const groupingMode = (process.env.DOC_GROUPING_MODE ?? "feature").toLowerCase();
  const buckets =
    groupingMode === "folder"
      ? (() => {
          const folderBuckets = new Map<string, ParsedFile[]>();
          for (const file of parsedFiles) {
            const moduleKey = resolveModuleKey(file.file_path);
            const existing = folderBuckets.get(moduleKey) ?? [];
            existing.push(file);
            folderBuckets.set(moduleKey, existing);
          }
          return folderBuckets;
        })()
      : groupFilesByBusinessFeature(parsedFiles, codeMap, resolveModuleKey);

  // Sắp xếp module theo điểm Call Graph (ưu tiên logic nghiệp vụ lên trước DTO/getter-setter)
  const scoredBuckets = [...buckets.entries()]
    .map(([moduleKey, groupFiles]) => {
      const fileSet = new Set(groupFiles.map((f) => f.file_path));
      const moduleNodes = codeMap.filter((n) => fileSet.has(n.file_path));
      const score = computeModuleImportanceScore(moduleNodes, inDegreeMap);
      const chunks = splitBucketByMaxNodes(moduleKey, groupFiles, codeMap, maxNodesPerDoc);
      return { moduleKey, fileCount: groupFiles.length, score, chunks };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.fileCount - a.fileCount ||
        a.moduleKey.localeCompare(b.moduleKey)
    );

  // Chọn theo kiểu Round-Robin (phủ đều part 1 của tất cả module quan trọng nhất trước khi lấy part 2, 3...)
  const selected: ModuleGroup[] = [];
  let round = 0;
  while (selected.length < maxModuleDocs) {
    let addedInRound = false;
    for (const bucket of scoredBuckets) {
      const chunk = bucket.chunks[round];
      if (chunk) {
        selected.push(chunk);
        addedInRound = true;
        if (selected.length >= maxModuleDocs) break;
      }
    }
    if (!addedInRound) break;
    round += 1;
  }

  return selected;
}

/**
 * Gộp (Map-Reduce) các tài liệu nhiều phần (`part1`, `part2`...) thuộc cùng 1 module
 * thành 1 DocItem duy nhất để kết quả trả về cho Nhóm 2.2 (RAG) và preview.html rành mạch.
 */
function mergeMultiPartModuleDocs(
  entries: Array<{ group: ModuleGroup; doc: DocItem }>
): DocItem[] {
  const byModule = new Map<string, Array<{ group: ModuleGroup; doc: DocItem }>>();
  for (const entry of entries) {
    const list = byModule.get(entry.group.moduleKey) ?? [];
    list.push(entry);
    byModule.set(entry.group.moduleKey, list);
  }

  const merged: DocItem[] = [];
  for (const [moduleKey, parts] of byModule.entries()) {
    if (parts.length === 1) {
      merged.push(parts[0]!.doc);
      continue;
    }

    const firstGroup = parts[0]!.group;
    const baseSlug = firstGroup.baseSlug;

    const combinedMarkdown = parts
      .map((p, idx) => `## Phần ${idx + 1}: ${p.doc.title}\n\n${p.doc.markdown}`)
      .join("\n\n---\n\n");

    const mergedSpecsMap = new Map<string, string[]>();
    for (const p of parts) {
      for (const spec of p.doc.specs ?? []) {
        const vals = mergedSpecsMap.get(spec.key) ?? [];
        if (!vals.includes(spec.value)) {
          vals.push(spec.value);
        }
        mergedSpecsMap.set(spec.key, vals);
      }
    }
    const combinedSpecs = [...mergedSpecsMap.entries()].map(([key, values]) => ({
      key,
      value: values.join(" | "),
    }));

    const combinedSourceNodeIds = Array.from(
      new Set(parts.flatMap((p) => p.doc.source_node_ids))
    );

    const bestMermaid =
      parts
        .map((p) => p.doc.mermaid_diagram)
        .filter((m): m is string => Boolean(m && m.trim().length > 0))
        .sort((a, b) => b.length - a.length)[0] ?? null;

    merged.push({
      doc_id: `doc_module_${baseSlug}`,
      title: `Tài liệu kỹ thuật Module ${moduleKey}`,
      path: `modules/${baseSlug}.md`,
      ...(combinedSpecs.length > 0 ? { specs: combinedSpecs } : {}),
      markdown: combinedMarkdown,
      mermaid_diagram: bestMermaid,
      source_node_ids: combinedSourceNodeIds,
    });
  }

  return merged;
}

async function readBundledSourceContent(
  repoDir: string,
  files: ParsedFile[]
): Promise<string> {
  const chunks: string[] = [];
  let currentChars = 0;

  for (const file of files) {
    const absPath = path.resolve(repoDir, file.file_path);
    let raw = "";
    try {
      raw = await fs.readFile(absPath, "utf-8");
    } catch {
      continue;
    }

    const header = `// ====== FILE: ${file.file_path} ======\n`;
    const remaining = MAX_SOURCE_CHARS_PER_DOC - currentChars;
    if (remaining <= 200) {
      chunks.push(
        `// ... Đã lược bớt file ${file.file_path} để tránh tràn context (dùng tool doc_ma_nguon_ham để đọc chi tiết hàm).`
      );
      break;
    }

    const slice =
      raw.length + header.length > remaining
        ? `${raw.slice(0, Math.max(0, remaining - header.length))}\n// ... [truncated — dùng doc_ma_nguon_ham(node_id) để xem toàn bộ hàm]`
        : raw;

    chunks.push(`${header}${slice}`);
    currentChars += header.length + slice.length;
  }

  return chunks.join("\n\n");
}

function buildOverviewDocument(params: {
  repoUrl: string;
  branch: string;
  commitSha: string;
  projectInfo: DetectedProjectInfo;
  parsedFiles: ParsedFile[];
  codeMap: CodeMapNode[];
  moduleDocs: DocItem[];
}): DocItem {
  const { repoUrl, branch, commitSha, projectInfo, parsedFiles, codeMap, moduleDocs } = params;
  const edgeLines: string[] = [];
  const labelById = new Map(codeMap.map((node) => [node.node_id, node.name]));

  for (const node of codeMap) {
    for (const targetId of node.calls) {
      const targetName = labelById.get(targetId);
      if (!targetName) continue;
      const safeFrom = node.name.replace(/"/g, "'");
      const safeTo = targetName.replace(/"/g, "'");
      edgeLines.push(`  ${node.node_id}["${safeFrom}"] --> ${targetId}["${safeTo}"]`);
      if (edgeLines.length >= 25) break;
    }
    if (edgeLines.length >= 25) break;
  }

  const mermaidDiagram =
    edgeLines.length > 0 ? `flowchart LR\n${edgeLines.join("\n")}` : null;

  const languagesSummary =
    Object.entries(projectInfo.languages)
      .map(([lang, count]) => `${lang} (${count} file)`)
      .join(", ") || "Không xác định";
  const frameworksSummary =
    projectInfo.frameworks.length > 0 ? projectInfo.frameworks.join(", ") : "Thuần ngôn ngữ gốc";

  const specs = [
    {
      key: "Repository & Phiên bản",
      value: `${repoUrl} (nhánh \`${branch}\`, commit \`${commitSha}\`).`,
    },
    {
      key: "Ngôn ngữ & Framework phát hiện",
      value: `Ngôn ngữ chính: ${projectInfo.primary_language ?? "N/A"} (${languagesSummary}); Frameworks: ${frameworksSummary}.`,
    },
    {
      key: "Quy mô phân tích AST",
      value: `Đã phân tích ${parsedFiles.length} file mã nguồn, trích xuất ${codeMap.length} hàm/phương thức và sinh ${moduleDocs.length} tài liệu thành phần qua AI Harness.`,
    },
    {
      key: "Danh sách tài liệu thành phần",
      value:
        moduleDocs.map((d) => `${d.title} (${d.path})`).join("; ") ||
        "Không có tài liệu thành phần riêng.",
    },
  ];

  const moduleLinksMarkdown =
    moduleDocs.length > 0
      ? moduleDocs.map((d) => `- **${d.title}** (\`${d.path}\`)`).join("\n")
      : "- Không có module con.";

  const markdown = [
    `## Tổng quan kiến trúc dự án`,
    "",
    specs.map((s) => `- **${s.key}:** ${s.value}`).join("\n"),
    "",
    "## Các tài liệu thành phần đã sinh",
    moduleLinksMarkdown,
  ].join("\n");

  return {
    doc_id: "doc_overview",
    title: "Tổng quan kiến trúc & bản đồ mã nguồn",
    path: "overview.md",
    specs,
    markdown,
    mermaid_diagram: mermaidDiagram,
    source_node_ids: codeMap.slice(0, 50).map((node) => node.node_id),
  };
}

async function loadSystemPromptV3(): Promise<string> {
  const promptPath = path.resolve(
    process.cwd(),
    "src",
    "ai_harness",
    "prompts",
    "system_prompt_v3.txt"
  );
  if (await fileExists(promptPath)) {
    return fs.readFile(promptPath, "utf-8");
  }
  return DEFAULT_STRUCTURED_JSON_PROMPT;
}

/**
 * Pipeline hoàn chỉnh:
 * 1) Clone GitHub repo (hỗ trợ branch + commit_sha)
 * 2) Quét & parse AST bằng Tree-sitter -> dựng code_map
 * 3) Sinh tài liệu kỹ thuật chi tiết qua AI Harness (Prompt v3 + 3 Tools + Self-Check <= 3 lần + specs [{ key, value }])
 * 4) Ghi file JSON local + backup lên Supabase
 */
export class TreeSitterJobQueue implements JobQueue {
  private readonly reposBaseDir: string;
  private readonly keepClonedRepo: boolean;
  private readonly llmProviderOverride?: LLMProviderName;
  private readonly maxModuleDocs: number;
  private readonly maxNodesPerDoc: number;
  private readonly interDocDelayMs: number;

  constructor(
    private readonly jobStore: JobStore,
    private readonly fileStorage: LocalFileStorage,
    options: TreeSitterJobQueueOptions = {}
  ) {
    this.reposBaseDir =
      options.reposBaseDir ?? path.resolve(process.cwd(), "data", "repos");
    this.keepClonedRepo = options.keepClonedRepo ?? false;
    this.llmProviderOverride = options.llmProvider;
    this.maxModuleDocs =
      options.maxModuleDocs ?? Number(process.env.MAX_AI_MODULES ?? 8);
    this.maxNodesPerDoc =
      options.maxNodesPerDoc ?? Number(process.env.MAX_NODES_PER_DOC ?? DEFAULT_MAX_NODES_PER_DOC);
    this.interDocDelayMs =
      options.interDocDelayMs ?? Number(process.env.AI_INTER_DOC_DELAY_MS ?? 2500);
  }

  enqueue(jobId: string, payload: AnalyzeRequest): void {
    const startedAt = Date.now();
    setImmediate(() => {
      void this.processRealJob(jobId, payload, startedAt);
    });
  }

  private createJobLLMClient(metrics: MetricsTracker): LLMClient {
    const candidate = new LLMClient({
      ...(this.llmProviderOverride ? { provider: this.llmProviderOverride } : {}),
      metrics,
    });
    if (!candidate.hasValidApiKey()) {
      logger.warn(
        "LLM_API_KEY chưa được cấu hình hợp lệ trong .env; tự động chuyển AI Harness sang chế độ 'mock' để job vẫn hoàn tất an toàn."
      );
      return new LLMClient({ provider: "mock", metrics });
    }
    return candidate;
  }

  private async processRealJob(
    jobId: string,
    payload: AnalyzeRequest,
    startedAt: number
  ): Promise<void> {
    const cloneDir = path.join(this.reposBaseDir, jobId);

    try {
      logger.info("Cloning repository for Tree-sitter + AI Harness analysis", {
        job_id: jobId,
        repo_url: payload.repo_url,
        branch: payload.branch,
        commit_sha: payload.commit_sha,
      });

      const cloned = await cloneGithubRepository(
        payload.repo_url,
        cloneDir,
        payload.branch,
        payload.commit_sha
      );

      const { projectInfo, parsedFiles, codeMap, fullCodeMap } =
        await analyzeRepositoryToCodeMap(cloned.repoDir, payload.changed_files);

      const resolvedCommitSha = payload.commit_sha ?? cloned.commitSha;
      const metrics = new MetricsTracker();
      const llm = this.createJobLLMClient(metrics);
      const systemPrompt = await loadSystemPromptV3();

      const moduleGroups = groupFilesForDocumentation(
        parsedFiles,
        codeMap,
        this.maxModuleDocs,
        this.maxNodesPerDoc
      );

      const generatedModuleEntries: Array<{ group: ModuleGroup; doc: DocItem }> = [];
      let totalToolCalls = 0;
      let totalAttemptsUsed = 0;
      const isRealLlm = llm.getProviderInfo().provider !== "mock";

      for (let i = 0; i < moduleGroups.length; i++) {
        const group = moduleGroups[i];
        if (!group) continue;

        if (i > 0 && isRealLlm && this.interDocDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.interDocDelayMs));
        }

        // Chỉ đọc fallback nội dung file trong trường hợp hiếm khi file không có bất kỳ hàm/route nào trong code_map
        // Còn mặc định (group.nodes.length > 0): CHỈ gửi code_map vào prompt, để AI tự gọi doc_ma_nguon_ham(node_id)!
        const useCodeMapOnly = group.nodes.length > 0;
        const fallbackSourceContent = useCodeMapOnly
          ? undefined
          : await readBundledSourceContent(cloned.repoDir, group.files);

        if (!useCodeMapOnly && !fallbackSourceContent?.trim()) continue;

        logger.info("AI Harness generating module documentation from code_map", {
          job_id: jobId,
          step: `${i + 1}/${moduleGroups.length}`,
          target: group.targetLabel,
          nodes_count: group.nodes.length,
          code_map_only_prompt: useCodeMapOnly,
        });

        const genResult = await generateDocumentWithSelfCheck({
          llm,
          docId: group.docId,
          docPath: group.docPath,
          targetFilePath: group.targetLabel,
          codeMapOnly: useCodeMapOnly,
          ...(fallbackSourceContent ? { sourceContent: fallbackSourceContent } : {}),
          codeMap,
          scopedNodes: group.nodes,
          fullRepoCodeMap: fullCodeMap,
          repoDir: cloned.repoDir,
          enableTools: true,
          maxRetries: 3,
          systemPrompt,
        });

        metrics.recordDocumentCheck({
          hallucinatedCount: genResult.finalVerification.hallucinatedSymbols.length,
          referencedCount: genResult.finalVerification.referencedSymbolCount,
          validBeforeRetry: genResult.initialMermaidValid,
          validAfterRetry: genResult.finalVerification.mermaidCheck.valid,
        });

        totalToolCalls += genResult.toolCallsCount;
        totalAttemptsUsed += genResult.attemptsUsed;
        generatedModuleEntries.push({ group, doc: genResult.document });
      }

      const moduleDocs = mergeMultiPartModuleDocs(generatedModuleEntries);

      const overviewDoc = buildOverviewDocument({
        repoUrl: payload.repo_url,
        branch: cloned.branch,
        commitSha: resolvedCommitSha,
        projectInfo,
        parsedFiles,
        codeMap,
        moduleDocs,
      });

      const documents: DocItem[] = [...moduleDocs, overviewDoc];

      const resultPayload: LocalJobResult = {
        job_id: jobId,
        status: "done",
        commit_sha: resolvedCommitSha,
        code_map: codeMap,
        documents,
      };

      const resultPath = await this.fileStorage.saveJobResult(jobId, resultPayload);
      const metricsSummary = metrics.summarize();
      const providerInfo = llm.getProviderInfo();

      await this.jobStore.update(jobId, {
        status: "done",
        commit_sha: resolvedCommitSha,
        result_path: resultPath,
        code_map: codeMap,
        documents,
        metadata: {
          pipeline_mode: "tree_sitter_ai_harness_v3",
          llm_provider: providerInfo.provider,
          llm_model: providerInfo.model,
          resolved_branch: cloned.branch,
          parsed_files_count: parsedFiles.length,
          code_map_nodes_count: codeMap.length,
          documents_count: documents.length,
          total_tokens: metricsSummary.totalTokens,
          tool_calls_count: totalToolCalls,
          self_check_attempts: totalAttemptsUsed,
          hallucination_rate_percent: metricsSummary.hallucinationRatePercent,
          mermaid_valid_percent: metricsSummary.mermaidSuccessAfterPercent,
          duration_ms: Date.now() - startedAt,
          changed_files_count: payload.changed_files.length,
        },
        error: null,
      });

      logger.info("Tree-sitter + AI Harness job completed successfully", {
        job_id: jobId,
        llm_provider: providerInfo.provider,
        llm_model: providerInfo.model,
        parsed_files_count: parsedFiles.length,
        code_map_nodes_count: codeMap.length,
        documents_count: documents.length,
        tool_calls_count: totalToolCalls,
        total_tokens: metricsSummary.totalTokens,
        result_path: resultPath,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected Tree-sitter / AI Harness processing error";
      logger.error("Background analysis job failed", {
        job_id: jobId,
        reason: message,
      });

      try {
        await this.jobStore.update(jobId, {
          status: "failed",
          error: {
            code: "JOB_PROCESSING_FAILED",
            message,
          },
        });
      } catch (updateErr) {
        logger.error("Failed to persist failed status to JobStore", {
          job_id: jobId,
          reason: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
    } finally {
      if (!this.keepClonedRepo) {
        await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
