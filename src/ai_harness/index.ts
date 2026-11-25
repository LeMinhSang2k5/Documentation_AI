/**
 * CỔNG GIAO TIẾP DUY NHẤT (PUBLIC FACADE) CỦA TRỤ CỘT AI HARNESS
 * Các module trong src/api/ hoặc src/cli/ chỉ cần import từ "../ai_harness/index.js".
 */

export { LLMClient, type LLMClientConfig } from "./llmClient.js";
export { MetricsTracker, type RunSummaryMetrics } from "./metrics.js";
export {
  AI_DOCUMENT_JSON_SCHEMA,
  AIDocumentOutputSchema,
  LocalJobResultSchema,
  type AIDocumentOutput,
} from "./schema.js";
export {
  createMermaidLiveUrl,
  kiem_tra_cu_phap_so_do,
  stripMarkdownFence,
} from "./tools/checkMermaid.js";
export { doc_ma_nguon_ham } from "./tools/readSource.js";
export {
  xem_ham_lien_quan,
  type RelatedFunctionsResult,
} from "./tools/relatedFunctions.js";
export {
  extractReferencedCodeSymbols,
  generateDocumentWithSelfCheck,
  verifyDocument,
} from "./verifier.js";
export * from "./harnessTypes.js";
