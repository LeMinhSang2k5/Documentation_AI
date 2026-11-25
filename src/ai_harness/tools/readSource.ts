import fs from "node:fs/promises";
import path from "node:path";
import type { CodeMapNode } from "../../types/index.js";

/**
 * Công cụ Tool Calling #1: doc_ma_nguon_ham(node_id)
 * Đọc chính xác nội dung mã nguồn của một hàm dựa trên tọa độ dòng trong code_map.
 */
export async function doc_ma_nguon_ham(
  nodeId: string,
  codeMap: CodeMapNode[],
  repoDir: string
): Promise<{ found: boolean; content: string }> {
  const node = codeMap.find((item) => item.node_id === nodeId);
  if (!node) {
    return {
      found: false,
      content: `Không tìm thấy node_id "${nodeId}" trong code_map.`,
    };
  }

  try {
    const absPath = path.resolve(repoDir, node.file_path);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    const startIdx = Math.max(0, node.start_line - 1);
    const endIdx = Math.min(lines.length, node.end_line);
    const snippet = lines.slice(startIdx, endIdx).join("\n");

    return {
      found: true,
      content: [
        `// File: ${node.file_path} (dòng ${node.start_line}-${node.end_line})`,
        `// Symbol: ${node.name} (${node.node_id})`,
        snippet,
      ].join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { found: false, content: `Lỗi đọc mã nguồn cho "${nodeId}": ${msg}` };
  }
}
