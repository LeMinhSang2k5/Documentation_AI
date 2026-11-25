import { createRequire } from "node:module";

/**
 * Mermaid chỉ chạy được khi có DOM (window/document). Ở Node ta dựng một DOM giả
 * bằng jsdom rồi mới import mermaid, để dùng đúng bộ parser mà trình duyệt dùng.
 * Khởi tạo lười (lazy) và chỉ một lần cho cả tiến trình.
 */
type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;

async function bootMermaid(): Promise<MermaidApi> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  if (!g.window) g.window = dom.window;
  if (!g.document) g.document = dom.window.document;

  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", logLevel: "fatal" });
  return mermaid;
}

export function getMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= bootMermaid();
  return mermaidPromise;
}

export interface MermaidParseOutcome {
  ok: boolean;
  diagramType?: string;
  message?: string;
  line?: number;
}

export async function parseMermaid(code: string): Promise<MermaidParseOutcome> {
  const mermaid = await getMermaid();
  try {
    const result = await mermaid.parse(code);
    if (!result) return { ok: false, message: "Mermaid could not parse the diagram" };
    return { ok: true, diagramType: result.diagramType };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const lineMatch = /on line (\d+)/i.exec(raw);
    return {
      ok: false,
      message: raw.trim(),
      line: lineMatch ? Number(lineMatch[1]) : undefined,
    };
  }
}

const require = createRequire(import.meta.url);

/** Phiên bản mermaid đang cài, để trang preview tải đúng bản trùng với bộ kiểm tra. */
export function installedMermaidVersion(): string {
  const pkg = require("mermaid/package.json") as { version: string };
  return pkg.version;
}
