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
      codeMap,
      codeMap,
      file.content
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

  const finalProviderInfo = llm.getProviderInfo();
  const summary = metrics.summarize();
  const mermaidFailRecords = records.filter((r) => !r.mermaidValid);
  const mermaidSectionNotes =
    summary.diagramsValidBeforeRetry === summary.diagramsChecked
      ? [
          `   - Trên ${summary.diagramsChecked} file mẫu ngắn của dự án, lần chạy với \`${finalProviderInfo.model}\` đạt **${summary.diagramsValidBeforeRetry}/${summary.diagramsChecked} sơ đồ hợp lệ** ngay lần đầu theo \`kiem_tra_cu_phap_so_do\`.`,
          '   - Dù vậy, với các file/luồng phức tạp hơn ở bản thô `v1`, AI vẫn có rủi ro đặt dấu ngoặc tròn `()` trong nhãn `[...]` chưa bọc `"..."` hoặc nhầm cú pháp mũi tên giữa `sequenceDiagram` và `flowchart` (đã tái hiện và kiểm chứng trong `tests/ai-harness.test.ts`).',
        ]
      : [
          `   - Có **${mermaidFailRecords.length}/${summary.diagramsChecked} sơ đồ** mắc lỗi cú pháp ngay lần đầu:`,
          ...mermaidFailRecords.map(
            (r) => `     - \`${r.filePath}\`: ${r.mermaidErrors.join("; ")}`
          ),
        ];

  const hallucinationSummaryNote =
    summary.totalHallucinatedSymbols === 0
      ? `   - Khi bật đối chiếu đầy đủ với \`code_map\` nâng cấp và mã nguồn gốc \`file.content\` (sau PR #6), tỷ lệ nghi vấn bịa đặt giảm còn **${summary.hallucinationRatePercent}% (${summary.totalHallucinatedSymbols}/${summary.totalReferencedSymbols})** — loại bỏ hoàn toàn tình trạng báo động giả (false positive 68.42% ở bản sơ khai với hàm con \`useCallback\` và method của \`export const api\`).`
      : `   - Sau khi đối chiếu với \`code_map\` và mã nguồn gốc \`file.content\`, vẫn còn **${summary.totalHallucinatedSymbols}/${summary.totalReferencedSymbols} định danh (${summary.hallucinationRatePercent}%)** nằm ngoài mã nguồn thật khi chạy bản thô \`v1\` (gửi file rời rạc không có \`code_map\`/tools).`;

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

  const reportMarkdown = [
    "# Báo cáo Khảo sát Lỗi Sinh Tài liệu & Sơ đồ của AI — Tuần 1 (Nhóm 2.1)",
    "",
    "## 1. Thông tin thực nghiệm khảo sát (Bản thô `v1` — Phương án A)",
    `- **Nguồn dữ liệu khảo sát:** \`${repoLabel}\` *(đối chiếu với \`code_map\` quét bằng Tree-sitter và mã nguồn gốc của dự án)*`,
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
    "## 4. Nhận xét, Giới hạn thực tế & Định hướng AI Harness (Tuần 2–5)",
    "1. **Kết quả kiểm tra cú pháp Mermaid:**",
    ...mermaidSectionNotes,
    "   - *Giới hạn hiện tại:* Hàm `kiem_tra_cu_phap_so_do` trong `src/ai_harness/tools/checkMermaid.ts` đang kiểm tra cú pháp bằng **Regex + Stack thủ công** chứ chưa dùng parser Mermaid chính thức (`mermaid.parse()`), nên vẫn có khả năng bỏ sót một số lỗi cú pháp hiếm.",
    "2. **Phát hiện thực nghiệm về đối chiếu tên hàm & False Positive (PR #6):**",
    hallucinationSummaryNote,
    "   - *Bài học từ Tuần 1:* Ở bản khảo sát sơ khai (trước PR #6), bộ đếm từng báo 68.42% định danh ngoài `code_map` do Tree-sitter đời đầu chưa tách hàm `useCallback` và method của object `api`. Từ phát hiện đó, nhóm đã nâng cấp parser (`src/parser/languages/typescript.ts`) và truyền mã nguồn gốc vào `verifyDocument` (`appearsInSourceCode` + `normalizeVerifiedExternalBackticks`) để loại bỏ báo nhầm.",
    "3. **Kiến trúc AI Harness (`v2 -> v3`) & Hướng cải tiến Tuần 2:**",
    "   - Đã khóa cấu trúc JSON đầu ra qua `AIDocumentOutputSchema` (`specs: [{ key, value }]`, `markdown`, `mermaid_diagram`, `source_node_ids`), kết hợp 3 công cụ (`doc_ma_nguon_ham`, `xem_ham_lien_quan`, `kiem_tra_cu_phap_so_do`) và vòng tự sửa tối đa 3 lần (`maxRetries = 3`).",
    "   - *Các giới hạn cần xử lý tiếp ở Tuần 2:*",
    "     - `verifyDocument` mới kiểm tra tĩnh các định danh bọc backtick; chưa tự kiểm tra được sai sót về logic nghiệp vụ (ví dụ mô tả ngược điều kiện boolean) hoặc hàm bịa không bọc backtick.",
    "     - Đồng bộ ID nút trong `mermaid_diagram` trùng khớp với `node_id` trong `code_map` để hỗ trợ Nhóm 2.2 bấm vào sơ đồ nhảy tới đúng dòng code.",
    "     - Bổ sung kiểm tra chặn Path Traversal trong `src/ai_harness/tools/readSource.ts` và cơ chế retry `429` cho nhánh `generateOpenAI` (OpenRouter).",
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
