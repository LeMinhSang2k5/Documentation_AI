import fs from "node:fs/promises";
import path from "node:path";
import { analyzeRepositoryToCodeMap } from "../parser/index.js";
import type { LocalFileStorage } from "../storage/fileStorage.js";
import type { JobStore } from "../storage/jobStore.js";
import type {
  AnalyzeRequest,
  CodeMapNode,
  DocItem,
  LocalJobResult,
  SampleOutputData,
} from "../types/index.js";
import { readJsonFile } from "../utils/fileIO.js";
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

    // Không giữ tiến trình Node nếu server đang đóng trong test
    timer.unref?.();
  }

  private async processMockJob(
    jobId: string,
    payload: AnalyzeRequest,
    startedAt: number
  ): Promise<void> {
    try {
      const sample = await readJsonFile<SampleOutputData>(this.sampleFilePath);
      const resolvedCommitSha = payload.commit_sha ?? sample.commit_sha;

      const resultPayload: LocalJobResult = {
        job_id: jobId,
        status: "done",
        commit_sha: resolvedCommitSha,
        code_map: sample.code_map,
        documents: sample.documents,
      };

      // 1. Lưu file JSON kết quả vào thư mục local data/jobs/<job_id>/result.json
      const resultPath = await this.fileStorage.saveJobResult(jobId, resultPayload);

      // 2. Backup dữ liệu & metadata lên bảng doc_jobs trên Supabase
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
}

function buildOverviewDocument(
  repoUrl: string,
  branch: string,
  commitSha: string,
  parsedFilesCount: number,
  codeMap: CodeMapNode[]
): DocItem {
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

  const uniqueFiles = Array.from(new Set(codeMap.map((node) => node.file_path)));
  const fileListPreview = uniqueFiles
    .slice(0, 15)
    .map((filePath) => `- \`${filePath}\``)
    .join("\n");

  const markdown = [
    `## Tổng quan phân tích Tree-sitter`,
    ``,
    `- **Repository:** ${repoUrl}`,
    `- **Branch:** \`${branch}\``,
    `- **Commit:** \`${commitSha}\``,
    `- **Số file đã parse:** ${parsedFilesCount}`,
    `- **Tổng số hàm/method trong \`code_map\`:** ${codeMap.length}`,
    ``,
    uniqueFiles.length > 0
      ? `### Danh sách file tiêu biểu\n\n${fileListPreview}${uniqueFiles.length > 15 ? `\n- ... (+${uniqueFiles.length - 15} file khác)` : ""}`
      : `Không tìm thấy hàm/method nào thuộc ngôn ngữ hỗ trợ trong phạm vi quét.`,
  ].join("\n");

  return {
    doc_id: "doc_overview",
    title: "Tổng quan cấu trúc mã nguồn (Tree-sitter)",
    path: "overview.md",
    markdown,
    mermaid_diagram: mermaidDiagram,
    source_node_ids: codeMap.slice(0, 50).map((node) => node.node_id),
  };
}

/**
 * Pipeline thật: clone GitHub repo -> quét & parse AST bằng Tree-sitter -> dựng code_map thật.
 */
export class TreeSitterJobQueue implements JobQueue {
  private readonly reposBaseDir: string;
  private readonly keepClonedRepo: boolean;

  constructor(
    private readonly jobStore: JobStore,
    private readonly fileStorage: LocalFileStorage,
    options: TreeSitterJobQueueOptions = {}
  ) {
    this.reposBaseDir =
      options.reposBaseDir ?? path.resolve(process.cwd(), "data", "repos");
    this.keepClonedRepo = options.keepClonedRepo ?? false;
  }

  enqueue(jobId: string, payload: AnalyzeRequest): void {
    const startedAt = Date.now();
    setImmediate(() => {
      void this.processRealJob(jobId, payload, startedAt);
    });
  }

  private async processRealJob(
    jobId: string,
    payload: AnalyzeRequest,
    startedAt: number
  ): Promise<void> {
    const cloneDir = path.join(this.reposBaseDir, jobId);

    try {
      logger.info("Cloning repository for Tree-sitter analysis", {
        job_id: jobId,
        repo_url: payload.repo_url,
        branch: payload.branch,
      });

      const cloned = await cloneGithubRepository(
        payload.repo_url,
        cloneDir,
        payload.branch
      );

      const { parsedFiles, codeMap } = await analyzeRepositoryToCodeMap(
        cloned.repoDir,
        payload.changed_files
      );

      const resolvedCommitSha = payload.commit_sha ?? cloned.commitSha;
      const documents: DocItem[] = [
        buildOverviewDocument(
          payload.repo_url,
          cloned.branch,
          resolvedCommitSha,
          parsedFiles.length,
          codeMap
        ),
      ];

      const resultPayload: LocalJobResult = {
        job_id: jobId,
        status: "done",
        commit_sha: resolvedCommitSha,
        code_map: codeMap,
        documents,
      };

      const resultPath = await this.fileStorage.saveJobResult(jobId, resultPayload);

      await this.jobStore.update(jobId, {
        status: "done",
        commit_sha: resolvedCommitSha,
        result_path: resultPath,
        code_map: codeMap,
        documents,
        metadata: {
          pipeline_mode: "tree_sitter_real",
          resolved_branch: cloned.branch,
          parsed_files_count: parsedFiles.length,
          code_map_nodes_count: codeMap.length,
          duration_ms: Date.now() - startedAt,
          changed_files_count: payload.changed_files.length,
        },
        error: null,
      });

      logger.info("Tree-sitter job completed successfully", {
        job_id: jobId,
        parsed_files_count: parsedFiles.length,
        code_map_nodes_count: codeMap.length,
        result_path: resultPath,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unexpected Tree-sitter processing error";
      logger.error("Tree-sitter background job failed", {
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
