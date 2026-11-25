import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateDocumentWithSelfCheck,
  LLMClient,
  LocalJobResultSchema,
  MetricsTracker,
} from "../../src/ai_harness/index.js";
import type { DocItem, LocalJobResult } from "../../src/types/index.js";
import { writeJsonFile } from "../../src/utils/fileIO.js";
import { logger } from "../../src/utils/logger.js";
import {
  loadSampleRepoWithTreeSitter,
  parseWeek1CliArgs,
} from "./repoLoader.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, "..", "..");

async function main(): Promise<void> {
  const options = parseWeek1CliArgs(process.argv);
  const { repoLabel, commitSha, files, codeMap } =
    await loadSampleRepoWithTreeSitter(options, 3);

  const metrics = new MetricsTracker();
  const llm = new LLMClient({
    ...(options.useMock ? { provider: "mock" } : {}),
    metrics,
  });
  const providerInfo = llm.getProviderInfo();

  logger.info("Generating verified sample JSON for Group 2.2 (Week 1)", {
    provider: providerInfo.provider,
    model: providerInfo.model,
    files_count: files.length,
    code_map_nodes: codeMap.length,
  });

  const documents: DocItem[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;

    const baseName = path.basename(file.relativePath, path.extname(file.relativePath));
    const docId = `doc_${baseName.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase()}`;
    const docPath = `modules/${baseName}.md`;

    logger.info("Generating and verifying document", {
      step: `${i + 1}/${files.length}`,
      file_path: file.relativePath,
    });

    const result = await generateDocumentWithSelfCheck({
      llm,
      docId,
      docPath,
      targetFilePath: file.relativePath,
      sourceContent: file.content,
      codeMap,
      maxRetries: 3,
    });

    metrics.recordDocumentCheck({
      hallucinatedCount: result.finalVerification.hallucinatedSymbols.length,
      referencedCount: result.finalVerification.referencedSymbolCount,
      validBeforeRetry: result.initialMermaidValid,
      validAfterRetry: result.finalVerification.mermaidCheck.valid,
    });

    logger.info("Document verified", {
      doc_id: docId,
      attempts_used: result.attemptsUsed,
      mermaid_valid: result.finalVerification.mermaidCheck.valid,
    });

    documents.push(result.document);
  }

  const jobPayload: LocalJobResult = {
    job_id: "doc_job_2026_001",
    status: "done",
    commit_sha: commitSha,
    code_map: codeMap,
    documents,
  };

  const validatedPayload = LocalJobResultSchema.parse(jobPayload);

  const resultsDir = path.join(PROJECT_ROOT, "experiments", "results");
  await fs.mkdir(resultsDir, { recursive: true });

  const jsonOutputPath = path.join(resultsDir, "sample_for_group_2_2.json");
  await writeJsonFile(jsonOutputPath, validatedPayload);

  const flowDocPath = path.join(resultsDir, "api_flow_2_1_and_2_2.md");
  await fs.writeFile(
    flowDocPath,
    buildGroupApiFlowMarkdown(repoLabel, commitSha),
    "utf-8"
  );

  const summary = metrics.summarize();
  logger.info("Week 1 Group 2.2 sample JSON exported successfully", {
    json_path: jsonOutputPath,
    flow_doc_path: flowDocPath,
    total_tokens: summary.totalTokens,
    mermaid_valid_percent: summary.mermaidSuccessAfterPercent,
  });
}

function buildGroupApiFlowMarkdown(repoUrl: string, commitSha: string): string {
  return [
    "# Sơ đồ Luồng Dữ liệu Giao tiếp HTTP API giữa Nhóm 2.1 và Nhóm 2.2",
    "",
    "Tài liệu dùng để thống nhất hợp đồng giao tiếp cuối Tuần 1 giữa **Nhóm 2.1 (Code Documentation Generator)** và **Nhóm 2.2 (Cổng xem tài liệu & Hỏi đáp mã nguồn)**.",
    "",
    "```mermaid",
    "sequenceDiagram",
    '  participant User as "Người dùng cuối"',
    '  participant G22 as "Nhóm 2.2 (Portal & Q&A - DB riêng)"',
    '  participant API21 as "Nhóm 2.1 HTTP API (X-API-Key)"',
    '  participant Parser as "Nhóm 2.1 Tree-sitter Parser"',
    '  participant Harness as "Nhóm 2.1 AI Harness"',
    "",
    "  User->>G22: Nhập link GitHub + branch/commit",
    "  G22->>API21: POST /api/v1/docs/analyze (repo_url, branch, commit_sha, changed_files)",
    '  API21-->>G22: 202 Accepted { job_id: "doc_job_2026_001", status: "processing" }',
    "  API21->>Parser: Clone repo & quét AST tạo code_map",
    "  Parser-->>Harness: Danh sách CodeMapNode (node_id, start_line, end_line, calls)",
    "  Harness->>Harness: Sinh tài liệu theo tầng + Self-check (check tên hàm & Mermaid <= 3 lần)",
    "  Harness-->>API21: Lưu bộ kết quả { code_map, documents } theo job_id",
    "  loop Polling định kỳ",
    "    G22->>API21: GET /api/v1/docs/jobs/doc_job_2026_001 (Header X-API-Key)",
    '    API21-->>G22: 200 OK { status: "done", commit_sha, code_map, documents }',
    "  end",
    "  G22->>User: Hiển thị Markdown + Sơ đồ Mermaid & liên kết dòng code theo source_node_ids",
    "```",
    "",
    "## Thông tin bộ mẫu đã xuất kèm",
    `- **Dự án mẫu:** \`${repoUrl}\``,
    `- **Commit SHA:** \`${commitSha}\``,
    "- **File JSON mẫu:** `experiments/results/sample_for_group_2_2.json`",
    "",
  ].join("\n");
}

main().catch((err: unknown) => {
  logger.error("Export sample JSON failed", {
    reason: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
