import path from "node:path";
import type { LocalJobResult } from "../types/index.js";
import { fileExists, readJsonFile, writeJsonFile } from "../utils/fileIO.js";

const SAFE_JOB_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function isValidJobId(jobId: string): boolean {
  return SAFE_JOB_ID_RE.test(jobId);
}

export function assertSafeJobId(jobId: string): void {
  if (!isValidJobId(jobId)) {
    throw new Error(`Unsafe job_id rejected: ${jobId}`);
  }
}

export class LocalFileStorage {
  private readonly rootDir: string;
  private readonly jobsBaseDir: string;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
    this.jobsBaseDir = path.resolve(this.rootDir, "data", "jobs");
  }

  /**
   * Ghi kết quả JSON ra data/jobs/<job_id>/result.json và trả về đường dẫn tương đối chuẩn '/'.
   */
  async saveJobResult(jobId: string, result: LocalJobResult): Promise<string> {
    assertSafeJobId(jobId);

    const targetPath = path.resolve(this.jobsBaseDir, jobId, "result.json");
    if (!targetPath.startsWith(`${this.jobsBaseDir}${path.sep}`)) {
      throw new Error("Path traversal detected while resolving job result path");
    }

    await writeJsonFile(targetPath, result);
    return `data/jobs/${jobId}/result.json`;
  }

  /**
   * Đọc kết quả JSON từ đường dẫn tương đối result_path (trả về null nếu file không tồn tại).
   */
  async readJobResult(resultPath: string): Promise<LocalJobResult | null> {
    if (!resultPath || resultPath.startsWith("/") || resultPath.includes("..")) {
      return null;
    }

    const absPath = path.resolve(this.rootDir, resultPath);
    if (!absPath.startsWith(`${this.jobsBaseDir}${path.sep}`)) {
      return null;
    }

    if (!(await fileExists(absPath))) {
      return null;
    }

    return readJsonFile<LocalJobResult>(absPath);
  }
}
