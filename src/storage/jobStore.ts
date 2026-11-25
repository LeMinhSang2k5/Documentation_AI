import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobPatch, JobRecord, NewJobRecord } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { isValidJobId, LocalFileStorage } from "./fileStorage.js";

export interface JobStore {
  create(job: NewJobRecord): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | null>;
  update(jobId: string, patch: JobPatch): Promise<JobRecord>;
}

const TABLE_NAME = "doc_jobs";

export class SupabaseJobStore implements JobStore {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly fileStorage: LocalFileStorage = new LocalFileStorage()
  ) {}

  async create(job: NewJobRecord): Promise<JobRecord> {
    const { data, error } = await this.supabase
      .from(TABLE_NAME)
      .insert({
        job_id: job.job_id,
        repo_url: job.repo_url,
        branch: job.branch,
        commit_sha: job.commit_sha,
        changed_files: job.changed_files,
        status: job.status,
        result_path: job.result_path,
        code_map: job.code_map,
        documents: job.documents,
        metadata: job.metadata,
        error: job.error,
      })
      .select("*")
      .single();

    if (error || !data) {
      throw new Error(`Supabase insert failed: ${error?.message ?? "No row returned"}`);
    }

    return data as JobRecord;
  }

  async get(jobId: string): Promise<JobRecord | null> {
    if (!isValidJobId(jobId)) {
      return null;
    }

    const { data, error } = await this.supabase
      .from(TABLE_NAME)
      .select("*")
      .eq("job_id", jobId)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase select failed: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    const record = data as JobRecord;

    // Ưu tiên đọc từ file JSON local nếu job đã hoàn tất và có result_path;
    // Nếu file local bị xóa hoặc chạy trên máy khác, tự động fallback sang bản backup trên Supabase.
    if (record.status === "done" && record.result_path) {
      try {
        const localData = await this.fileStorage.readJobResult(record.result_path);
        if (localData) {
          return {
            ...record,
            commit_sha: localData.commit_sha,
            code_map: localData.code_map,
            documents: localData.documents,
          };
        }
        logger.warn("Local result file missing; falling back to Supabase backup", {
          job_id: jobId,
          result_path: record.result_path,
        });
      } catch (readErr) {
        logger.warn("Failed reading local result file; falling back to Supabase backup", {
          job_id: jobId,
          reason: readErr instanceof Error ? readErr.message : String(readErr),
        });
      }
    }

    return record;
  }

  async update(jobId: string, patch: JobPatch): Promise<JobRecord> {
    const updatePayload: Record<string, unknown> = {
      ...patch,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from(TABLE_NAME)
      .update(updatePayload)
      .eq("job_id", jobId)
      .select("*")
      .single();

    if (error || !data) {
      throw new Error(`Supabase update failed: ${error?.message ?? "No row returned"}`);
    }

    return data as JobRecord;
  }
}
