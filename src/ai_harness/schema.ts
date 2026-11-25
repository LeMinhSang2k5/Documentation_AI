import { z } from "zod";

/**
 * Schema ép khuôn đầu ra của AI (Mục 3.2 tài liệu PDF):
 * Bắt buộc trả về JSON gồm title, markdown, mermaid_diagram, source_node_ids.
 */
export const AIDocumentOutputSchema = z.object({
  title: z.string().min(1, "title không được để trống"),
  markdown: z.string().min(1, "markdown không được để trống"),
  mermaid_diagram: z.string().nullable(),
  source_node_ids: z.array(z.string()),
});

export type AIDocumentOutput = z.infer<typeof AIDocumentOutputSchema>;

/** JSON Schema chuẩn truyền vào Gemini / OpenAI Structured Outputs */
export const AI_DOCUMENT_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Tiêu đề ngắn gọn, rõ ràng của trang tài liệu kỹ thuật",
    },
    markdown: {
      type: "string",
      description: "Nội dung tài liệu kỹ thuật định dạng Markdown, bám sát code thật",
    },
    mermaid_diagram: {
      type: "string",
      description: "Mã sơ đồ Mermaid thuần túy (không bọc trong dấu ```mermaid)",
    },
    source_node_ids: {
      type: "array",
      items: { type: "string" },
      description: "Danh sách các node_id từ code_map mà tài liệu này mô tả",
    },
  },
  required: ["title", "markdown", "mermaid_diagram", "source_node_ids"],
  additionalProperties: false,
} as const;

export const CodeMapNodeSchema = z.object({
  node_id: z.string().min(1),
  name: z.string().min(1),
  file_path: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  calls: z.array(z.string()),
});

export const DocItemSchema = z.object({
  doc_id: z.string().min(1),
  title: z.string().min(1),
  path: z.string().min(1),
  markdown: z.string().min(1),
  mermaid_diagram: z.string().nullable(),
  source_node_ids: z.array(z.string()),
});

export const LocalJobResultSchema = z.object({
  job_id: z.string().min(1),
  status: z.literal("done"),
  commit_sha: z.string().min(1),
  code_map: z.array(CodeMapNodeSchema),
  documents: z.array(DocItemSchema),
});
