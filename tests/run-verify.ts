import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type { SupabaseClient } from "@supabase/supabase-js";
import { MockJobQueue } from "../src/api/jobQueue.js";
import { createApp } from "../src/index.js";
import { LocalFileStorage } from "../src/storage/fileStorage.js";
import { SupabaseJobStore } from "../src/storage/jobStore.js";
import type { JobRecord } from "../src/types/index.js";

/**
 * Giả lập bảng public.doc_jobs của Supabase ngay trong bộ nhớ để kiểm thử toàn diện
 * SupabaseJobStore + LocalFileStorage + Express HTTP API (6 TC + TC5b fallback backup)
 * ngay cả khi chưa điền thông tin Supabase cloud vào .env.
 */
function createInMemorySupabaseMock(): {
  client: SupabaseClient;
  rows: Map<string, JobRecord>;
} {
  const rows = new Map<string, JobRecord>();

  const client = {
    from(table: string) {
      assert.equal(table, "doc_jobs");
      return {
        insert(payload: Omit<JobRecord, "created_at" | "updated_at">) {
          return {
            select(_cols: string) {
              return {
                async single() {
                  if (rows.has(payload.job_id)) {
                    return { data: null, error: { message: "duplicate key value" } };
                  }
                  const now = new Date().toISOString();
                  const record: JobRecord = {
                    ...payload,
                    created_at: now,
                    updated_at: now,
                  };
                  rows.set(payload.job_id, structuredClone(record));
                  return { data: structuredClone(record), error: null };
                },
              };
            },
          };
        },
        select(_cols: string) {
          return {
            eq(col: string, val: string) {
              assert.equal(col, "job_id");
              return {
                async maybeSingle() {
                  const found = rows.get(val) ?? null;
                  return { data: found ? structuredClone(found) : null, error: null };
                },
              };
            },
          };
        },
        update(patch: Partial<JobRecord>) {
          return {
            eq(col: string, val: string) {
              assert.equal(col, "job_id");
              return {
                select(_cols: string) {
                  return {
                    async single() {
                      const existing = rows.get(val);
                      if (!existing) {
                        return { data: null, error: { message: "Row not found" } };
                      }
                      const updated: JobRecord = {
                        ...existing,
                        ...patch,
                      };
                      rows.set(val, structuredClone(updated));
                      return { data: structuredClone(updated), error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, rows };
}

async function main(): Promise<void> {
  const testApiKey = "test-ephemeral-key-week1";
  process.env.API_KEY = testApiKey;

  const rootDir = process.cwd();
  const createdJobIds: string[] = [];

  const { client: supabaseMock, rows } = createInMemorySupabaseMock();
  const fileStorage = new LocalFileStorage(rootDir);
  const jobStore = new SupabaseJobStore(supabaseMock, fileStorage);
  const jobQueue = new MockJobQueue(jobStore, fileStorage, { delayMs: 1200 });

  const app = createApp(jobStore, jobQueue);
  const server = app.listen(0);

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    console.log(`Running verify-api.sh against ${baseUrl} ...`);
    const scriptPath = path.resolve(
      rootDir,
      ".agent/skills/week1-http-api-verify/scripts/verify-api.sh"
    );

    const { stdout } = await execFileAsync("bash", [scriptPath], {
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        API_KEY: testApiKey,
        POLL_WAIT: "2",
      },
      encoding: "utf-8",
    });
    console.log(stdout.trim());

    // Lấy job_id vừa tạo trong verify-api.sh để kiểm thử TC5b (file local + fallback backup Supabase)
    for (const id of rows.keys()) {
      createdJobIds.push(id);
    }
    assert.equal(createdJobIds.length, 1, "Expected 1 job stored in doc_jobs");
    const jobId = createdJobIds[0]!;

    const localResultFile = path.resolve(rootDir, "data", "jobs", jobId, "result.json");
    const stat = await fs.stat(localResultFile);
    assert.ok(stat.size > 0, "TC5b: Local result.json must exist and be non-empty");
    console.log(`[PASS] TC5b-1 Local JSON file created at data/jobs/${jobId}/result.json`);

    // Xóa thử file local rồi gọi lại GET -> phải tự động fallback sang bản backup trên Supabase
    await fs.rm(path.dirname(localResultFile), { recursive: true, force: true });

    const fallbackRes = await fetch(`${baseUrl}/api/v1/docs/jobs/${jobId}`, {
      headers: { "X-API-Key": testApiKey },
    });
    assert.equal(fallbackRes.status, 200, "TC5b: Fallback GET must return 200");
    const fallbackBody = (await fallbackRes.json()) as {
      status: string;
      code_map: unknown[];
      documents: unknown[];
    };
    assert.equal(fallbackBody.status, "done");
    assert.ok(fallbackBody.code_map.length > 0, "TC5b: Fallback code_map must not be empty");
    assert.ok(fallbackBody.documents.length > 0, "TC5b: Fallback documents must not be empty");
    console.log("[PASS] TC5b-2 Deleted local file -> GET seamlessly fell back to Supabase backup");

    // Kiểm tra thêm các ca bảo mật: path traversal trong changed_files & fileStorage
    const traversalRes = await fetch(`${baseUrl}/api/v1/docs/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": testApiKey,
      },
      body: JSON.stringify({
        repo_url: "https://github.com/example/sample-backend",
        changed_files: ["../etc/passwd"],
      }),
    });
    assert.equal(traversalRes.status, 400, "Path traversal in changed_files must return 400");
    console.log("[PASS] Security: changed_files path traversal '../etc/passwd' blocked with 400");

    await assert.rejects(
      () =>
        fileStorage.saveJobResult("../escape", {
          job_id: "bad",
          status: "done",
          commit_sha: "a1b2c3",
          code_map: [],
          documents: [],
        }),
      /Unsafe job_id/
    );
    console.log("[PASS] Security: fileStorage unsafe job_id '../escape' rejected");

    console.log("ALL VERIFICATION CHECKS PASSED!");
  } finally {
    for (const id of createdJobIds) {
      await fs.rm(path.resolve(rootDir, "data", "jobs", id), { recursive: true, force: true });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
