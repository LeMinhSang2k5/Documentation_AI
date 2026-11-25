import { Router } from "express";
import type { JobStore } from "../storage/jobStore.js";
import { requireApiKey } from "./auth.js";
import { createDocsController } from "./controller.js";
import type { JobQueue } from "./jobQueue.js";

export function createDocsRouter(jobStore: JobStore, jobQueue: JobQueue): Router {
  const router = Router();
  const controller = createDocsController(jobStore, jobQueue);

  // Bắt buộc mọi endpoint dưới /api/v1/docs/* phải đi qua xác thực X-API-Key
  router.use(requireApiKey);

  router.post("/analyze", controller.analyzeRepo);
  router.get("/jobs/:job_id", controller.getJobStatus);

  return router;
}
