import path from "node:path";
import type { CodeMapNode, DocItem } from "../types/index.js";
import type {
  SelfCheckGenerationResult,
  VerificationResult,
} from "./harnessTypes.js";
import type { LLMClient } from "./llmClient.js";
import { AIDocumentOutputSchema, type AIDocumentOutput } from "./schema.js";
import { kiem_tra_cu_phap_so_do, stripMarkdownFence } from "./tools/checkMermaid.js";

const DEFAULT_STRUCTURED_JSON_PROMPT = [
  "Bạn là Kỹ sư Tài liệu Kỹ thuật (Technical Writer) chính xác và súc tích.",
  "Quy tắc bắt buộc:",
  "1. Chỉ mô tả đúng các hàm, lớp, tham số thực sự tồn tại trong mã nguồn và danh sách code_map được cung cấp; nghiêm cấm tự suy diễn thêm hàm ngoại lai.",
  "2. Mọi mã node_id trong source_node_ids bắt buộc lấy chính xác từ code_map. Trong markdown chỉ bọc dấu backtick cho các hàm có trong code_map.",
  '3. Trường mermaid_diagram chỉ chứa mã Mermaid thuần túy (bắt đầu bằng sequenceDiagram hoặc flowchart TD/LR, không bọc ```mermaid). Mọi nhãn chứa khoảng trắng hoặc dấu ngoặc () phải bọc trong ngoặc kép "...".',
  "4. Trả về đúng đối tượng JSON khớp schema: { title, markdown, mermaid_diagram, source_node_ids }.",
].join("\n");

const IGNORED_COMMON_IDENTIFIERS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "string",
  "number",
  "boolean",
  "object",
  "any",
  "void",
  "never",
  "unknown",
  "Promise",
  "Array",
  "Record",
  "Map",
  "Set",
  "Error",
  "Date",
  "JSON",
  "Express",
  "Request",
  "Response",
  "NextFunction",
  "Router",
  "fetch",
  "localStorage",
  "sessionStorage",
  "window",
  "document",
  "console.log",
  "console.error",
  "process.env",
]);

export function verifyDocument(
  doc: Pick<DocItem, "markdown" | "mermaid_diagram" | "source_node_ids">,
  codeMap: CodeMapNode[]
): VerificationResult {
  const validNodeIds = new Set(codeMap.map((n) => n.node_id));
  const validSymbolNames = buildKnownSymbolSet(codeMap);

  const invalidSourceNodeIds = doc.source_node_ids.filter((id) => !validNodeIds.has(id));

  const extractedSymbols = extractReferencedCodeSymbols(doc.markdown, validSymbolNames);
  const hallucinatedSymbols = extractedSymbols.filter(
    (sym) => !isKnownSymbol(sym, validSymbolNames)
  );

  const mermaidCheck = kiem_tra_cu_phap_so_do(doc.mermaid_diagram);

  const feedbackParts: string[] = [];
  if (invalidSourceNodeIds.length > 0) {
    feedbackParts.push(
      `- Các mã source_node_ids sau KHÔNG tồn tại trong code_map: ${invalidSourceNodeIds.join(", ")}. Chỉ được chọn từ: [${[...validNodeIds].join(", ")}].`
    );
  }
  if (hallucinatedSymbols.length > 0) {
    feedbackParts.push(
      `- Phát hiện tên hàm/lớp không tồn tại trong code_map (nghi vấn bịa đặt): ${hallucinatedSymbols.map((s) => `\`${s}\``).join(", ")}. Chỉ bọc backtick các hàm có thật trong code_map: [${codeMap.map((n) => n.name).join(", ")}].`
    );
  }
  if (!mermaidCheck.valid) {
    feedbackParts.push(
      `- Sơ đồ Mermaid bị lỗi cú pháp:\n  ${mermaidCheck.errors.join("\n  ")}`
    );
  }

  const passed =
    invalidSourceNodeIds.length === 0 &&
    hallucinatedSymbols.length === 0 &&
    mermaidCheck.valid;

  return {
    passed,
    invalidSourceNodeIds,
    hallucinatedSymbols,
    referencedSymbolCount: extractedSymbols.length,
    mermaidCheck,
    feedbackForRetry: feedbackParts.length > 0 ? feedbackParts.join("\n") : undefined,
  };
}

export async function generateDocumentWithSelfCheck(params: {
  llm: LLMClient;
  docId: string;
  docPath: string;
  targetFilePath: string;
  sourceContent: string;
  codeMap: CodeMapNode[];
  maxRetries?: number;
  systemPrompt?: string;
}): Promise<SelfCheckGenerationResult> {
  const maxRetries = params.maxRetries ?? 3;
  const systemPrompt = params.systemPrompt ?? DEFAULT_STRUCTURED_JSON_PROMPT;

  const relevantNodes = params.codeMap.filter(
    (n) => n.file_path === params.targetFilePath
  );
  const nodesForPrompt = relevantNodes.length > 0 ? relevantNodes : params.codeMap;

  const baseUserPrompt = [
    `Hãy viết tài liệu kỹ thuật chuẩn xác cho file: ${params.targetFilePath}`,
    "",
    "=== DANH SÁCH CODE_MAP HỢP LỆ ===",
    JSON.stringify(nodesForPrompt, null, 2),
    "",
    "=== NỘI DUNG MÃ NGUỒN THỰC TẾ ===",
    params.sourceContent,
  ].join("\n");

  let currentUserPrompt = baseUserPrompt;
  let totalTokens = 0;
  let initialMermaidValid = false;
  let lastDoc: DocItem | null = null;
  let lastVerification: VerificationResult | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await params.llm.generate({
      systemPrompt,
      userPrompt: currentUserPrompt,
      expectJsonSchema: true,
      mockContext: {
        mode: "v2_structured",
        filePath: params.targetFilePath,
        codeMap: params.codeMap,
        retryAttempt: attempt,
      },
    });
    totalTokens += res.usage.totalTokens;

    let parsed: AIDocumentOutput;
    try {
      const jsonObj: unknown = JSON.parse(stripJsonWrapper(res.rawText));
      parsed = AIDocumentOutputSchema.parse(jsonObj);
    } catch (parseErr) {
      const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      currentUserPrompt = [
        baseUserPrompt,
        "",
        "=== YÊU CẦU SỬA LỖI ĐỊNH DẠNG JSON ===",
        `Phản hồi trước không đúng JSON Schema: ${errMsg}`,
        "Hãy trả về ĐÚNG đối tượng JSON gồm title, markdown, mermaid_diagram, source_node_ids.",
      ].join("\n");
      continue;
    }

    const cleanedMermaid = parsed.mermaid_diagram
      ? stripMarkdownFence(parsed.mermaid_diagram)
      : null;

    const candidateDoc: DocItem = {
      doc_id: params.docId,
      title: parsed.title,
      path: params.docPath,
      markdown: parsed.markdown,
      mermaid_diagram: cleanedMermaid,
      source_node_ids: parsed.source_node_ids,
    };

    const verification = verifyDocument(candidateDoc, params.codeMap);
    if (attempt === 0) {
      initialMermaidValid = verification.mermaidCheck.valid;
    }

    lastDoc = candidateDoc;
    lastVerification = verification;

    if (verification.passed) {
      return {
        document: candidateDoc,
        attemptsUsed: attempt + 1,
        initialMermaidValid,
        finalVerification: verification,
        totalTokens,
      };
    }

    if (attempt < maxRetries) {
      currentUserPrompt = [
        baseUserPrompt,
        "",
        `=== PHẢN HỒI TỪ BỘ KIỂM TRA TỰ ĐỘNG (LẦN SỬA ${attempt + 1}/${maxRetries}) ===`,
        "Bản nháp JSON trước của bạn mắc các lỗi sau:",
        verification.feedbackForRetry ?? "",
        "",
        "Bản nháp trước:",
        JSON.stringify(parsed, null, 2),
        "",
        "Hãy sửa triệt để toàn bộ lỗi trên và trả về JSON hợp lệ.",
      ].join("\n");
    }
  }

  if (!lastDoc || !lastVerification) {
    throw new Error(
      `Không thể sinh JSON hợp lệ cho ${params.targetFilePath} sau ${maxRetries + 1} lần gọi.`
    );
  }

  return {
    document: lastDoc,
    attemptsUsed: maxRetries + 1,
    initialMermaidValid,
    finalVerification: lastVerification,
    totalTokens,
  };
}

function buildKnownSymbolSet(codeMap: CodeMapNode[]): Set<string> {
  const known = new Set<string>();
  for (const node of codeMap) {
    known.add(node.node_id);
    known.add(node.name);
    for (const part of node.name.split(".")) {
      if (part) known.add(part);
    }
    known.add(node.file_path);
    const base = path.posix.basename(node.file_path);
    known.add(base);
    known.add(base.replace(/\.[^.]+$/, ""));
  }
  return known;
}

export function extractReferencedCodeSymbols(
  markdown: string,
  knownSymbols?: Set<string>
): string[] {
  const withoutCodeBlocks = markdown.replace(/```[\s\S]*?```/g, "");
  const matches = withoutCodeBlocks.matchAll(/`([^`\r\n]{2,80})`/g);
  const symbols = new Set<string>();

  for (const match of matches) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    if (raw.includes("/") || raw.includes("\\") || /\s/.test(raw)) continue;
    if (/\.(ts|tsx|js|jsx|py|cs|json|md|html|env|yml|yaml)$/i.test(raw) || raw.startsWith(".")) {
      continue;
    }

    const cleaned = raw.replace(/\([^)]*\)$/, "").trim();
    if (!cleaned || IGNORED_COMMON_IDENTIFIERS.has(cleaned)) continue;

    const matchesKnown = knownSymbols ? isKnownSymbol(cleaned, knownSymbols) : false;
    const looksLikeCallableOrQualified =
      matchesKnown ||
      raw.endsWith(")") ||
      /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(cleaned) ||
      /^fn_[a-z0-9_]+$/.test(cleaned);

    if (looksLikeCallableOrQualified) {
      symbols.add(cleaned);
    }
  }

  return [...symbols];
}

function isKnownSymbol(symbol: string, validSet: Set<string>): boolean {
  if (validSet.has(symbol)) return true;
  const parts = symbol.split(".");
  const first = parts[0];
  const second = parts[1];
  if (parts.length === 2 && first && second && validSet.has(first) && validSet.has(second)) {
    return true;
  }
  return false;
}

function stripJsonWrapper(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .trim();
}
