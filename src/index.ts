import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import { TreeSitterJobQueue, type JobQueue } from "./api/jobQueue.js";
import { createDocsRouter } from "./api/routes.js";
import { LocalFileStorage } from "./storage/fileStorage.js";
import { SupabaseJobStore, type JobStore } from "./storage/jobStore.js";
import { createSupabaseAdminClient } from "./storage/supabaseClient.js";
import { logger } from "./utils/logger.js";

export function createApp(jobStore: JobStore, jobQueue: JobQueue): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/v1/docs", createDocsRouter(jobStore, jobQueue));

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Endpoint not found",
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message: "Malformed JSON request body",
        },
      });
      return;
    }

    logger.error("Unhandled API error", {
      reason: err instanceof Error ? err.message : String(err),
    });

    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    });
  };

  app.use(errorHandler);
  return app;
}

function startServer(): void {
  const apiKey = process.env.API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing API_KEY in environment (.env)");
  }

  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  const supabaseClient = createSupabaseAdminClient();
  const fileStorage = new LocalFileStorage();
  const jobStore = new SupabaseJobStore(supabaseClient, fileStorage);
  const jobQueue = new TreeSitterJobQueue(jobStore, fileStorage);

  const app = createApp(jobStore, jobQueue);

  app.listen(port, () => {
    logger.info("Code Documentation Generator HTTP API started", { port });
  });
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(path.resolve(entryArg)).href) {
  try {
    startServer();
  } catch (err) {
    logger.error("Server failed to start", {
      reason: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
