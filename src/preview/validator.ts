import path from "node:path";
import { marked, type Token, type Tokens } from "marked";
import { createMermaidLiveUrl, verifyDocument } from "../ai_harness/index.js";
import type { CodeMapNode, DocItem } from "../types/index.js";
import { parseMermaid } from "./mermaidEngine.js";
import { resultSchema, type PreviewResult } from "./schema.js";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  severity: Severity;
  code: string;
  message: string;
  /** Dòng (1-based) trong markdown hoặc trong mã mermaid, nếu xác định được. */
  line?: number;
  /** "markdown" | "mermaid_diagram" | "code_map" | ... */
  field?: string;
}

export interface MermaidCheck {
  /** "mermaid_diagram" hoặc "markdown:L12" cho khối ```mermaid nhúng trong markdown. */
  source: string;
  ok: boolean;
  diagramType?: string;
}

/** Kết quả chạy bộ tự kiểm tra của AI Harness (src/ai_harness/verifier.ts) trên một tài liệu. */
export interface HarnessCheck {
  /** Tài liệu có qua được vòng self-check của harness không (không có sơ đồ thì không tính lỗi sơ đồ). */
  passed: boolean;
  invalid_source_node_ids: string[];
  hallucinated_symbols: string[];
  /** Số tên hàm/lớp được nhắc trong `markdown` (mẫu số của Hallucination Rate). */
  referenced_symbols: number;
  mermaid: {
    checked: boolean;
    valid: boolean;
    errors: string[];
    live_url: string | null;
  };
}

export interface DocumentReport {
  doc_id: string;
  title: string;
  path: string;
  issues: ValidationIssue[];
  mermaid: MermaidCheck[];
  harness: HarnessCheck;
}

export interface ValidationSummary {
  documents: number;
  code_map_nodes: number;
  errors: number;
  warnings: number;
  mermaid_total: number;
  mermaid_ok: number;
  /** Số tài liệu qua self-check của AI Harness. */
  harness_passed: number;
  hallucinated_symbols: number;
  referenced_symbols: number;
  /** hallucinated / referenced × 100, làm tròn 2 chữ số — cùng công thức với MetricsTracker. */
  hallucination_rate: number;
}

export interface ValidationReport {
  summary: ValidationSummary;
  /** Lỗi ở cấp toàn bộ kết quả (schema, code_map, trùng doc_id...). */
  global: ValidationIssue[];
  documents: DocumentReport[];
}

const issue = (
  severity: Severity,
  code: string,
  message: string,
  extra: Partial<ValidationIssue> = {}
): ValidationIssue => ({ severity, code, message, ...extra });

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

const FENCED_MERMAID_RE = /^\s*```+\s*mermaid\s*\n([\s\S]*?)\n\s*```+\s*$/i;

export interface MermaidValidation {
  ok: boolean;
  diagramType?: string;
  issues: ValidationIssue[];
  /** Mã đã được làm sạch (bỏ hàng rào ```mermaid nếu AI lỡ bọc vào). */
  code: string;
}

/** Kiểm tra cú pháp một sơ đồ Mermaid bằng chính parser của mermaid. */
export async function validateMermaid(
  data: string | null | undefined,
  field = "mermaid_diagram"
): Promise<MermaidValidation> {
  const issues: ValidationIssue[] = [];
  let code = data ?? "";

  const fenced = FENCED_MERMAID_RE.exec(code);
  if (fenced) {
    code = fenced[1] ?? "";
    issues.push(
      issue(
        "warning",
        "MERMAID_FENCED",
        "Diagram is wrapped in a ```mermaid fence; the field should contain raw Mermaid code only",
        { field }
      )
    );
  }

  if (code.trim() === "") {
    issues.push(issue("error", "MERMAID_EMPTY", "Mermaid diagram is empty", { field }));
    return { ok: false, issues, code };
  }

  const outcome = await parseMermaid(code);
  if (!outcome.ok) {
    issues.push(
      issue("error", "MERMAID_SYNTAX", outcome.message ?? "Invalid Mermaid syntax", {
        field,
        line: outcome.line,
      })
    );
  }
  return { ok: outcome.ok, diagramType: outcome.diagramType, issues, code };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export interface MarkdownContext {
  /** Đường dẫn của tài liệu đang kiểm tra (vd "modules/auth.md"), để giải link tương đối. */
  docPath?: string;
  /** Tập đường dẫn của mọi tài liệu trong bộ kết quả. */
  knownDocPaths?: Set<string>;
}

export interface MarkdownValidation {
  issues: ValidationIssue[];
  mermaid: MermaidCheck[];
}

interface FenceBlock {
  info: string;
  startLine: number;
  body: string;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING_RE = /^ {0,3}(#{1,6})(.*)$/;

/**
 * Duyệt markdown theo dòng: tìm khối code (để biết khối nào chưa đóng, khối nào là mermaid)
 * và heading nằm ngoài khối code.
 */
function scanLines(markdown: string, issues: ValidationIssue[]): FenceBlock[] {
  const lines = markdown.split(/\r?\n/);
  const fences: FenceBlock[] = [];
  let open: { marker: string; info: string; startLine: number; body: string[] } | null = null;
  let headingCount = 0;
  let lastLevel = 0;

  lines.forEach((text, idx) => {
    const lineNo = idx + 1;

    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(text);
      const marker = close?.[1];
      if (marker && marker[0] === open.marker[0] && marker.length >= open.marker.length) {
        fences.push({ info: open.info, startLine: open.startLine, body: open.body.join("\n") });
        open = null;
      } else {
        open.body.push(text);
      }
      return;
    }

    const fence = FENCE_OPEN_RE.exec(text);
    if (fence && fence[1] && !(fence[1][0] === "`" && (fence[2] ?? "").includes("`"))) {
      open = { marker: fence[1], info: (fence[2] ?? "").trim(), startLine: lineNo, body: [] };
      return;
    }

    const heading = ATX_HEADING_RE.exec(text);
    if (heading && heading[1]) {
      const rest = heading[2] ?? "";
      if (rest !== "" && !/^\s/.test(rest)) {
        // "#Title" không phải heading theo CommonMark -> sẽ hiển thị như đoạn văn.
        issues.push(
          issue("warning", "MD_HEADING_NO_SPACE", `Missing space after '${heading[1]}' — this line will not render as a heading`, {
            field: "markdown",
            line: lineNo,
          })
        );
        return;
      }
      const level = heading[1].length;
      headingCount += 1;
      if (rest.replace(/#+\s*$/, "").trim() === "") {
        issues.push(issue("warning", "MD_EMPTY_HEADING", "Heading has no text", { field: "markdown", line: lineNo }));
      }
      if (lastLevel > 0 && level > lastLevel + 1) {
        issues.push(
          issue("warning", "MD_HEADING_SKIP", `Heading level jumps from h${lastLevel} to h${level}`, {
            field: "markdown",
            line: lineNo,
          })
        );
      }
      lastLevel = level;
    }
  });

  if (open) {
    const unclosed = open as { marker: string; startLine: number };
    issues.push(
      issue("error", "MD_UNCLOSED_FENCE", `Code block opened with ${unclosed.marker} is never closed`, {
        field: "markdown",
        line: unclosed.startLine,
      })
    );
  }

  if (headingCount === 0 && markdown.trim() !== "") {
    issues.push(issue("warning", "MD_NO_HEADING", "Document has no heading", { field: "markdown" }));
  }

  return fences;
}

function walkTokens(tokens: Token[] | undefined, visit: (token: Token) => void): void {
  if (!tokens) return;
  for (const token of tokens) {
    visit(token);
    const t = token as Token & {
      tokens?: Token[];
      items?: Tokens.ListItem[];
      header?: Tokens.TableCell[];
      rows?: Tokens.TableCell[][];
    };
    walkTokens(t.tokens, visit);
    if (t.items) walkTokens(t.items as Token[], visit);
    if (t.header) t.header.forEach((cell) => walkTokens(cell.tokens, visit));
    if (t.rows) t.rows.forEach((row) => row.forEach((cell) => walkTokens(cell.tokens, visit)));
  }
}

function lineOf(markdown: string, raw: string): number | undefined {
  const idx = markdown.indexOf(raw);
  return idx < 0 ? undefined : markdown.slice(0, idx).split("\n").length;
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/** Giải link tương đối "../x.md#y" so với đường dẫn tài liệu hiện tại. */
export function resolveDocLink(fromDocPath: string | undefined, href: string): string {
  const target = href.split("#")[0]?.split("?")[0] ?? "";
  const base = fromDocPath ? path.posix.dirname(fromDocPath) : ".";
  return path.posix.normalize(path.posix.join(base, decodeURIComponent(target))).replace(/^\.\//, "");
}

/**
 * Kiểm tra markdown: khối code chưa đóng, heading, link hỏng, mermaid nhúng.
 * Tên hàm bịa ra do AI Harness (verifyDocument) kiểm tra ở validateDocument.
 */
export async function validateMarkdown(
  data: string | null | undefined,
  ctx: MarkdownContext = {}
): Promise<MarkdownValidation> {
  const markdown = data ?? "";
  const issues: ValidationIssue[] = [];
  const mermaid: MermaidCheck[] = [];

  if (markdown.trim() === "") {
    issues.push(issue("error", "MD_EMPTY", "Markdown content is empty", { field: "markdown" }));
    return { issues, mermaid };
  }

  const fences = scanLines(markdown, issues);

  for (const block of fences) {
    if (!/^mermaid\b/i.test(block.info)) continue;
    const result = await validateMermaid(block.body, `markdown:L${block.startLine}`);
    mermaid.push({ source: `markdown:L${block.startLine}`, ok: result.ok, diagramType: result.diagramType });
    for (const sub of result.issues) {
      // Đổi số dòng trong sơ đồ thành số dòng trong markdown.
      issues.push({
        ...sub,
        field: "markdown",
        line: sub.line !== undefined ? block.startLine + sub.line : block.startLine,
        message: `Embedded mermaid block: ${sub.message}`,
      });
    }
  }

  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown, { gfm: true });
  } catch (err) {
    issues.push(
      issue("error", "MD_PARSE", `Markdown could not be parsed: ${err instanceof Error ? err.message : String(err)}`, {
        field: "markdown",
      })
    );
    return { issues, mermaid };
  }

  walkTokens(tokens, (token) => {
    if (token.type === "link" || token.type === "image") {
      const link = token as Tokens.Link | Tokens.Image;
      const href = link.href.trim();
      const kind = token.type === "image" ? "Image" : "Link";
      if (href === "") {
        issues.push(issue("error", "MD_EMPTY_LINK", `${kind} '${link.text}' has an empty target`, {
          field: "markdown",
          line: lineOf(markdown, link.raw),
        }));
        return;
      }
      if (/^javascript:/i.test(href)) {
        issues.push(issue("error", "MD_UNSAFE_LINK", `${kind} uses a javascript: URL`, {
          field: "markdown",
          line: lineOf(markdown, link.raw),
        }));
        return;
      }
      if (token.type === "link" && link.text.trim() === "") {
        issues.push(issue("warning", "MD_EMPTY_LINK_TEXT", `Link to '${href}' has no text`, {
          field: "markdown",
          line: lineOf(markdown, link.raw),
        }));
      }
      if (
        ctx.knownDocPaths &&
        !isExternalHref(href) &&
        !href.startsWith("#") &&
        /\.md(?:[#?].*)?$/i.test(href)
      ) {
        const target = resolveDocLink(ctx.docPath, href);
        if (!ctx.knownDocPaths.has(target)) {
          issues.push(issue("warning", "MD_BROKEN_DOC_LINK", `Link points to '${target}', which is not a generated document`, {
            field: "markdown",
            line: lineOf(markdown, link.raw),
          }));
        }
      }
    }
  });

  return { issues, mermaid };
}

// ---------------------------------------------------------------------------
// Toàn bộ kết quả (code_map + documents)
// ---------------------------------------------------------------------------

function validateCodeMap(codeMap: CodeMapNode[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();

  for (const node of codeMap) {
    if (ids.has(node.node_id)) {
      issues.push(issue("error", "CODEMAP_DUPLICATE_ID", `Duplicate node_id '${node.node_id}'`, { field: "code_map" }));
    }
    ids.add(node.node_id);

    if (node.start_line < 1 || node.end_line < node.start_line) {
      issues.push(issue("error", "CODEMAP_BAD_RANGE", `'${node.node_id}' has invalid line range ${node.start_line}-${node.end_line}`, {
        field: "code_map",
      }));
    }
  }

  for (const node of codeMap) {
    for (const callee of node.calls) {
      if (!ids.has(callee)) {
        issues.push(issue("warning", "CODEMAP_UNKNOWN_CALL", `'${node.node_id}' calls unknown node '${callee}'`, {
          field: "code_map",
        }));
      }
    }
  }
  return issues;
}

/**
 * Chạy đúng bộ kiểm tra mà vòng self-check của AI Harness dùng (verifyDocument):
 * source_node_ids phải có trong code_map, tên hàm/lớp trong `markdown` phải có thật,
 * và mermaid_diagram phải qua kiem_tra_cu_phap_so_do.
 */
export function runHarnessCheck(doc: DocItem, codeMap: CodeMapNode[]): HarnessCheck {
  const verification = verifyDocument(doc, codeMap);
  const hasDiagram = doc.mermaid_diagram !== null && doc.mermaid_diagram.trim() !== "";
  // Sơ đồ là tuỳ chọn ("mermaid_diagram (nếu có)"): không có sơ đồ thì không tính là lỗi.
  const mermaidCheck = hasDiagram ? verification.mermaidCheck : null;
  return {
    passed:
      verification.invalidSourceNodeIds.length === 0 &&
      verification.hallucinatedSymbols.length === 0 &&
      (mermaidCheck?.valid ?? true),
    invalid_source_node_ids: verification.invalidSourceNodeIds,
    hallucinated_symbols: verification.hallucinatedSymbols,
    referenced_symbols: verification.referencedSymbolCount,
    mermaid: {
      checked: hasDiagram,
      valid: mermaidCheck?.valid ?? true,
      errors: mermaidCheck?.errors ?? [],
      live_url: hasDiagram ? createMermaidLiveUrl(doc.mermaid_diagram ?? "") : null,
    },
  };
}

function harnessIssues(doc: DocItem, harness: HarnessCheck): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const nodeId of harness.invalid_source_node_ids) {
    issues.push(issue("error", "DOC_UNKNOWN_NODE", `source_node_ids references '${nodeId}', which is not in code_map`, {
      field: "source_node_ids",
    }));
  }
  for (const symbol of harness.hallucinated_symbols) {
    issues.push(issue("error", "HALLUCINATED_SYMBOL", `\`${symbol}\` is not a function/class in code_map (AI harness: hallucination)`, {
      field: "markdown",
      line: lineOf(doc.markdown, `\`${symbol}`),
    }));
  }
  if (!harness.mermaid.valid) {
    // Trình duyệt dùng parser thật của mermaid (MERMAID_SYNTAX); đây là bộ kiểm tra chặt hơn mà
    // vòng self-check dùng để bắt AI sửa sơ đồ, nên chỉ là cảnh báo.
    issues.push(issue("warning", "HARNESS_MERMAID", `AI harness self-check rejects this diagram:\n${harness.mermaid.errors.join("\n")}`, {
      field: "mermaid_diagram",
    }));
  }
  return issues;
}

async function validateDocument(
  doc: DocItem,
  ctx: { codeMap: CodeMapNode[]; docPaths: Set<string> }
): Promise<DocumentReport> {
  const issues: ValidationIssue[] = [];
  const mermaid: MermaidCheck[] = [];

  if (doc.title.trim() === "") {
    issues.push(issue("error", "DOC_EMPTY_TITLE", "Document title is empty", { field: "title" }));
  }
  if (!/\.md$/i.test(doc.path)) {
    issues.push(issue("warning", "DOC_PATH_NOT_MD", `Document path '${doc.path}' does not end with .md`, { field: "path" }));
  }

  const harness = runHarnessCheck(doc, ctx.codeMap);
  issues.push(...harnessIssues(doc, harness));

  const md = await validateMarkdown(doc.markdown, { docPath: doc.path, knownDocPaths: ctx.docPaths });
  issues.push(...md.issues);
  mermaid.push(...md.mermaid);

  if (doc.mermaid_diagram !== null && doc.mermaid_diagram.trim() !== "") {
    const mm = await validateMermaid(doc.mermaid_diagram);
    issues.push(...mm.issues);
    mermaid.push({ source: "mermaid_diagram", ok: mm.ok, diagramType: mm.diagramType });
  }

  return { doc_id: doc.doc_id, title: doc.title, path: doc.path, issues, mermaid, harness };
}

/** Kiểm tra toàn bộ kết quả của một job (đã qua schema). */
export async function validateResult(result: PreviewResult): Promise<ValidationReport> {
  const global: ValidationIssue[] = [];

  if (result.status !== "done") {
    global.push(issue("error", "JOB_NOT_DONE", `Job status is '${result.status}', expected 'done'`, { field: "status" }));
  }

  global.push(...validateCodeMap(result.code_map));

  const docIds = new Set<string>();
  const docPaths = new Set<string>();
  for (const doc of result.documents) {
    if (docIds.has(doc.doc_id)) {
      global.push(issue("error", "DOC_DUPLICATE_ID", `Duplicate doc_id '${doc.doc_id}'`, { field: "documents" }));
    }
    if (docPaths.has(doc.path)) {
      global.push(issue("error", "DOC_DUPLICATE_PATH", `Duplicate document path '${doc.path}'`, { field: "documents" }));
    }
    docIds.add(doc.doc_id);
    docPaths.add(doc.path);
  }
  if (result.documents.length === 0) {
    global.push(issue("warning", "NO_DOCUMENTS", "Result contains no documents", { field: "documents" }));
  }

  const ctx = { codeMap: result.code_map, docPaths };

  const documents: DocumentReport[] = [];
  for (const doc of result.documents) {
    documents.push(await validateDocument(doc, ctx));
  }

  return { summary: summarize(global, documents, result), global, documents };
}

function summarize(global: ValidationIssue[], documents: DocumentReport[], result: PreviewResult): ValidationSummary {
  const all = [...global, ...documents.flatMap((d) => d.issues)];
  const diagrams = documents.flatMap((d) => d.mermaid);
  const hallucinated = documents.reduce((n, d) => n + d.harness.hallucinated_symbols.length, 0);
  const referenced = documents.reduce((n, d) => n + d.harness.referenced_symbols, 0);
  return {
    documents: documents.length,
    code_map_nodes: result.code_map.length,
    errors: all.filter((i) => i.severity === "error").length,
    warnings: all.filter((i) => i.severity === "warning").length,
    mermaid_total: diagrams.length,
    mermaid_ok: diagrams.filter((d) => d.ok).length,
    harness_passed: documents.filter((d) => d.harness.passed).length,
    hallucinated_symbols: hallucinated,
    referenced_symbols: referenced,
    hallucination_rate: referenced > 0 ? Number(((hallucinated / referenced) * 100).toFixed(2)) : 0,
  };
}

/** Kiểm tra schema JSON thô; trả về lỗi dạng ValidationIssue nếu sai định dạng. */
export function checkSchema(raw: unknown): { result?: PreviewResult; issues: ValidationIssue[] } {
  const parsed = resultSchema.safeParse(raw);
  if (parsed.success) return { result: parsed.data, issues: [] };
  return {
    issues: parsed.error.issues.map((zIssue) =>
      issue("error", "SCHEMA_INVALID", `${zIssue.path.map(String).join(".") || "(root)"}: ${zIssue.message}`, {
        field: zIssue.path.map(String).join("."),
      })
    ),
  };
}
