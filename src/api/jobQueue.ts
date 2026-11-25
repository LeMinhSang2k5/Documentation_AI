import path from "node:path";
import type { LocalFileStorage } from "../storage/fileStorage.js";
import type { JobStore } from "../storage/jobStore.js";
import type { AnalyzeRequest, LocalJobResult, SampleOutputData } from "../types/index.js";
import { readJsonFile } from "../utils/fileIO.js";
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
