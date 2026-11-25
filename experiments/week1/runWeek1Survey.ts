import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMermaidLiveUrl,
  LLMClient,
  MetricsTracker,
  verifyDocument,
} from "../../src/ai_harness/index.js";
import { logger } from "../../src/utils/logger.js";
import {
  loadSampleRepoWithTreeSitter,
  parseWeek1CliArgs,
} from "./repoLoader.js";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(CURRENT_DIR, "..", "..");

interface SurveyFileRecord {
  filePath: string;
  lineCount: number;
  knownFunctions: string[];
  hallucinatedSymbols: string[];
  mermaidCode: string;
  mermaidValid: boolean;
  mermaidErrors: string[];
  mermaidLiveUrl: string;
  tokensUsed: number;
}

function extractMermaidFromRawMarkdown(rawMarkdown: string): string {
  const fenceMatch = /```mermaid\s*([\s\S]*?)```/i.exec(rawMarkdown);
  return (fenceMatch?.[1] ?? "").trim();
}

async function main(): Promise<void> {
  const options = parseWeek1CliArgs(process.argv);
  const { repoLabel, files, codeMap } = await loadSampleRepoWithTreeSitter(
    options,
    4
  );

  const metrics = new MetricsTracker();
  const llm = new LLMClient({
    ...(options.useMock ? { provider: "mock" } : {}),
    metrics,
  });
  const providerInfo = llm.getProviderInfo();

  logger.info("Starting Week 1 AI Baseline Survey (v1)", {
    provider: providerInfo.provider,
    model: providerInfo.model,
    files_count: files.length,
  });

  const promptV1Path = path.join(
    PROJECT_ROOT,
    "src",
    "ai_harness",
    "prompts",
    "system_prompt_v1.txt"
  );
  const systemPromptV1 = await fs.readFile(promptV1Path, "utf-8");

  const records: SurveyFileRecord[] = [];

  for (const file of files) {
    logger.info("Sending isolated file to AI (v1)", {
      file_path: file.relativePath,
      lines: file.lineCount,
    });

    const response = await llm.generate({
      systemPrompt: systemPromptV1,
      userPrompt: `Đường dẫn file: ${file.relativePath}\n\nMã nguồn:\n${file.content}`,
      expectJsonSchema: false,
      mockContext: {
        mode: "v1_raw",
        filePath: file.relativePath,
        codeMap,
      },
    });

    const mermaidCode = extractMermaidFromRawMarkdown(response.rawText);
    const fileNodes = codeMap.filter((n) => n.file_path === file.relativePath);

    const check = verifyDocument(
      {
        markdown: response.rawText,
        mermaid_diagram: mermaidCode,
        source_node_ids: fileNodes.map((n) => n.node_id),
      },
      codeMap
    );

    metrics.recordDocumentCheck({
      hallucinatedCount: check.hallucinatedSymbols.length,
      referencedCount: check.referencedSymbolCount,
      validBeforeRetry: check.mermaidCheck.valid,
      validAfterRetry: check.mermaidCheck.valid,
    });

    records.push({
      filePath: file.relativePath,
      lineCount: file.lineCount,
      knownFunctions: fileNodes.map((n) => n.name),
      hallucinatedSymbols: check.hallucinatedSymbols,
      mermaidCode,
      mermaidValid: check.mermaidCheck.valid,
      mermaidErrors: check.mermaidCheck.errors,
      mermaidLiveUrl: mermaidCode
        ? check.mermaidCheck.mermaidLiveUrl
        : createMermaidLiveUrl('flowchart TD\n  Missing["AI không sinh khối mermaid"]'),
      tokensUsed: response.usage.totalTokens,
    });
  }

  const summary = metrics.summarize();
  const resultsDir = path.join(PROJECT_ROOT, "experiments", "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const reportPath = path.join(resultsDir, "week1_ai_error_report.md");

  const tableRows = records
    .map((r, idx) => {
      const funcs = r.knownFunctions.map((f) => `\`${f}\``).join(", ") || "*(top-level)*";
      const hallu =
        r.hallucinatedSymbols.length > 0
          ? `Có (${r.hallucinatedSymbols.map((h) => `\`${h}\``).join(", ")})`
          : "Không (0)";
      const mermaidStatus = r.mermaidValid ? "Hợp lệ (Pass)" : "Lỗi cú pháp (Fail)";
      const errDetail =
        r.mermaidErrors.length > 0 ? r.mermaidErrors.join(" <br> ") : "Không lỗi";
      return `| ${idx + 1} | \`${r.filePath}\` (${r.lineCount} dòng) | ${funcs} | ${hallu} | **${mermaidStatus}** | ${errDetail} | [Mở trên mermaid.live](${r.mermaidLiveUrl}) |`;
    })
    .join("\n");

  const mermaidSections = records
    .map(
      (r, idx) =>
        `### Sơ đồ ${idx + 1} — \`${r.filePath}\` (${r.mermaidValid ? "Hợp lệ" : "Lỗi cú pháp"})\n\n\`\`\`mermaid\n${r.mermaidCode || 'flowchart TD\n  Missing["Không có sơ đồ"]'}\n\`\`\``
    )
    .join("\n\n");

  const finalProviderInfo = llm.getProviderInfo();
  const reportMarkdown = [
    "# Báo cáo Khảo sát Lỗi Sinh Tài liệu & Sơ đồ của AI — Tuần 1 (Nhóm 2.1)",
    "",
    "## 1. Thông tin thực nghiệm khảo sát (Bản thô `v1` — Phương án A)",
    `- **Nguồn dữ liệu khảo sát:** \`${repoLabel}\` *(đối chiếu với \`code_map\` quét bằng Tree-sitter thật của nhóm)*`,
    `- **Provider / Model:** \`${finalProviderInfo.provider}\` / \`${finalProviderInfo.model}\``,
    `- **Số file gửi rời rạc:** ${records.length} file (không cung cấp \`code_map\` cho AI, không bật vòng tự kiểm tra)`,
    `- **Tổng lượng token tiêu thụ:** ${summary.totalTokens} tokens (Prompt: ${summary.promptTokens}, Completion: ${summary.completionTokens})`,
    `- **Tỷ lệ sơ đồ Mermaid hợp lệ ngay lần đầu:** **${summary.mermaidSuccessBeforePercent}%** (${summary.diagramsValidBeforeRetry}/${summary.diagramsChecked} sơ đồ)`,
    `- **Tỷ lệ tên hàm nghi vấn AI tự bịa (Hallucination Rate):** **${summary.hallucinationRatePercent}%** (${summary.totalHallucinatedSymbols}/${summary.totalReferencedSymbols} định danh hàm được nhắc tới)`,
    "",
    "## 2. Bảng thống kê chi tiết từng file",
    "",
    "| STT | File khảo sát | Các hàm Tree-sitter quét được | Tên hàm ngoài `code_map` / bịa | Cú pháp Mermaid | Chi tiết lỗi ghi nhận | Kiểm tra trực quan |",
    "| :---: | :--- | :--- | :--- | :---: | :--- | :---: |",
    tableRows,
    "",
    "## 3. Mã sơ đồ Mermaid gốc của từng file (Copy dán vào mermaid.live hoặc bấm Ctrl+Shift+V xem trực tiếp)",
    "",
    mermaidSections,
    "",
    "## 4. Nhận xét & Định hướng thiết kế AI Harness (Tuần 2–5)",
    "1. **Nhóm lỗi cú pháp Mermaid phổ biến khi chạy bản thô `v1`:**",
    '   - AI thường đặt dấu ngoặc tròn `()` trực tiếp bên trong nhãn `[]`, tiêu đề `subgraph` hoặc alias `participant` mà quên bọc trong dấu ngoặc kép `"..."`, làm trình biên dịch Mermaid gãy cú pháp.',
    '   - AI hay nhầm lẫn cú pháp mũi tên giữa `sequenceDiagram` (`A --> B: nhãn`) và `flowchart TD` (`A -->|"nhãn"| B`).',
    "2. **Nhóm lỗi ảo giác (Hallucination) khi gửi từng file rời rạc:**",
    "   - Khi thiếu `code_map` liên kết toàn cục, AI tự đoán thêm tên hàm phụ trợ ở các module khác không tồn tại trong `code_map`.",
    "3. **Giải pháp khắc phục trong AI Harness (`v2 -> v3`):**",
    "   - Khóa đầu ra bằng `AIDocumentOutputSchema` (Zod) và truyền danh sách `code_map` từ Tree-sitter vào `system_prompt_v2.txt`.",
    "   - Sử dụng `verifier.ts` + `kiem_tra_cu_phap_so_do` tự động đối chiếu tên hàm với `code_map` và gửi thông báo lỗi cú pháp Mermaid bắt AI tự sửa (tối đa 3 lần).",
    "",
  ].join("\n");

  await fs.writeFile(reportPath, reportMarkdown, "utf-8");
  logger.info("Week 1 AI error survey report generated", { report_path: reportPath });
}

main().catch((err: unknown) => {
  logger.error("Week 1 survey failed", {
    reason: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
