import crypto from "node:crypto";
import type { RequestHandler } from "express";
import type { JobStore } from "../storage/jobStore.js";
import type { JobQueue } from "./jobQueue.js";
import { analyzeRequestSchema } from "./schemas.js";

function generateJobId(): string {
  const ts = Date.now();
  const suffix = crypto.randomBytes(3).toString("hex");
  return `doc_job_${ts}_${suffix}`;
}

export function createDocsController(jobStore: JobStore, jobQueue: JobQueue) {
  const analyzeRepo: RequestHandler = async (req, res, next) => {
    try {
      const parsed = analyzeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        const fieldPath = firstIssue?.path.length ? `${firstIssue.path.join(".")}: ` : "";
        res.status(400).json({
          error: {
            code: "INVALID_INPUT",
            message: `${fieldPath}${firstIssue?.message ?? "Invalid request payload"}`,
          },
        });
        return;
      }

      const payload = parsed.data;
      const jobId = generateJobId();

      await jobStore.create({
        job_id: jobId,
        repo_url: payload.repo_url,
        branch: payload.branch,
        commit_sha: payload.commit_sha,
        changed_files: payload.changed_files,
        status: "processing",
        result_path: null,
        code_map: null,
        documents: null,
        metadata: {},
        error: null,
      });

      // Chạy nền bất đồng bộ — tuyệt đối không await trước khi trả 202
      jobQueue.enqueue(jobId, payload);

      res.status(202).json({
        job_id: jobId,
        status: "processing",
      });
    } catch (err) {
      next(err);
    }
  };

  const getJobStatus: RequestHandler = async (req, res, next) => {
    try {
      const rawParam = req.params.job_id;
      const jobId = Array.isArray(rawParam) ? rawParam[0] : rawParam;

      if (!jobId) {
        res.status(404).json({
          error: {
            code: "JOB_NOT_FOUND",
            message: "Job not found",
          },
        });
        return;
      }

      const job = await jobStore.get(jobId);
      if (!job) {
        res.status(404).json({
          error: {
            code: "JOB_NOT_FOUND",
            message: `Job '${jobId}' not found`,
          },
        });
        return;
      }

      if (job.status === "processing") {
        res.status(200).json({
          job_id: job.job_id,
          status: "processing",
        });
        return;
      }

      if (job.status === "failed") {
        res.status(200).json({
          job_id: job.job_id,
          status: "failed",
          error: job.error ?? {
            code: "JOB_PROCESSING_FAILED",
            message: "Documentation generation failed",
          },
        });
        return;
      }

      res.status(200).json({
        job_id: job.job_id,
        status: "done",
        commit_sha: job.commit_sha ?? "",
        code_map: job.code_map ?? [],
        documents: job.documents ?? [],
      });
    } catch (err) {
      next(err);
    }
  };

  return {
    analyzeRepo,
    getJobStatus,
  };
}
