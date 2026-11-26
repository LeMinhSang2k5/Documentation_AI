import type { FunctionDeclaration } from "@google/genai";
import type { ToolExecutionContext } from "../harnessTypes.js";
import { kiem_tra_cu_phap_so_do } from "./checkMermaid.js";
import { doc_ma_nguon_ham } from "./readSource.js";
import { xem_ham_lien_quan } from "./relatedFunctions.js";

export const HARNESS_TOOL_SCHEMAS = [
  {
    name: "doc_ma_nguon_ham",
    description:
      "Đọc nội dung mã nguồn thực tế (từ start_line đến end_line) của một hàm hoặc lớp bất kỳ trong dự án dựa theo node_id trong code_map. Hãy gọi công cụ này khi cần xem chi tiết tham số, logic bên trong hàm hoặc tra cứu hàm nằm ở file khác.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "Mã node_id chính xác của hàm/lớp trong code_map",
        },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "xem_ham_lien_quan",
    description:
      "Tra cứu danh sách các hàm mà node_id đang gọi tới (callsTo) và các hàm từ nơi khác gọi tới nó (calledBy) dựa trên code_map toàn dự án.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "Mã node_id chính xác của hàm/lớp cần tra cứu liên kết gọi hàm",
        },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "kiem_tra_cu_phap_so_do",
    description:
      "Kiểm tra mã sơ đồ Mermaid xem có hợp lệ cú pháp không trước khi chốt kết quả. Nếu trả về valid=false, hãy đọc mảng errors để sửa ngay.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        mermaid_code: {
          type: "string",
          description:
            "Chuỗi mã sơ đồ Mermaid thuần túy (bắt đầu bằng sequenceDiagram hoặc flowchart TD/LR, không bọc ```mermaid)",
        },
      },
      required: ["mermaid_code"],
      additionalProperties: false,
    },
  },
] as const;

export const HARNESS_GEMINI_TOOL_DECLARATIONS: FunctionDeclaration[] = HARNESS_TOOL_SCHEMAS.map(
  (tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parametersJsonSchema,
  })
);

export const HARNESS_OPENAI_TOOLS = HARNESS_TOOL_SCHEMAS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parametersJsonSchema,
  },
}));

export async function executeHarnessTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "doc_ma_nguon_ham": {
      const nodeId = typeof args.node_id === "string" ? args.node_id.trim() : "";
      if (!nodeId) {
        return { found: false, error: "Thiếu tham số node_id kiểu chuỗi." };
      }
      if (!ctx.repoDir) {
        const node = ctx.codeMap.find((item) => item.node_id === nodeId);
        return node
          ? {
              found: true,
              content: `// Symbol: ${node.name} (${node.file_path}:${node.start_line}-${node.end_line})\n// Calls: ${node.calls.join(", ") || "none"}`,
            }
          : { found: false, content: `Không tìm thấy node_id "${nodeId}" trong code_map.` };
      }
      return doc_ma_nguon_ham(nodeId, ctx.codeMap, ctx.repoDir);
    }

    case "xem_ham_lien_quan": {
      const nodeId = typeof args.node_id === "string" ? args.node_id.trim() : "";
      if (!nodeId) {
        return { found: false, error: "Thiếu tham số node_id kiểu chuỗi." };
      }
      const res = xem_ham_lien_quan(nodeId, ctx.codeMap);
      return {
        found: res.found,
        node: res.node ?? null,
        callsTo: res.callsTo,
        calledBy: res.calledBy,
      };
    }

    case "kiem_tra_cu_phap_so_do": {
      const mermaidCode = typeof args.mermaid_code === "string" ? args.mermaid_code : "";
      const check = kiem_tra_cu_phap_so_do(mermaidCode);
      return {
        valid: check.valid,
        diagramType: check.diagramType ?? null,
        errors: check.errors,
      };
    }

    default:
      return {
        error: `Công cụ không tồn tại: "${toolName}". Chỉ hỗ trợ doc_ma_nguon_ham, xem_ham_lien_quan, kiem_tra_cu_phap_so_do.`,
      };
  }
}
