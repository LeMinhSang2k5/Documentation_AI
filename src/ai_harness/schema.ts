import { z } from "zod";

export const DocSpecItemSchema = z.object({
  key: z.string().min(1, "specs[].key không được để trống"),
  value: z.string().min(1, "specs[].value không được để trống"),
});

/**
 * Schema ép khuôn đầu ra của AI (Mục 3.2 tài liệu PDF + nâng cấp đặc tả chi tiết dạng list [<key, value>]):
 * Bắt buộc trả về JSON gồm title, specs ([{ key, value }]), markdown, mermaid_diagram, source_node_ids.
 */
export const AIDocumentOutputSchema = z.object({
  title: z.string().min(1, "title không được để trống"),
  specs: z
    .array(DocSpecItemSchema)
    .min(1, "specs phải chứa ít nhất 1 cặp { key, value } mô tả chi tiết")
    .optional()
    .default([]),
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
    specs: {
      type: "array",
      description:
        "Danh sách đặc tả kỹ thuật chi tiết dạng cặp { key, value } (ví dụ: muc_dich, dau_vao_dau_ra, chi_tiet_ham, luong_xu_ly_chinh, phu_thuoc_ngoai, xu_ly_loi)",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Tên thuộc tính đặc tả (VD: 'Mục đích nghiệp vụ', 'Đầu vào & Đầu ra', 'Chi tiết các hàm', 'Luồng xử lý chính', 'Phụ thuộc & Tác dụng phụ', 'Kiểm tra hợp lệ & Xử lý lỗi')",
          },
          value: {
            type: "string",
            description:
              "Nội dung phân tích chi tiết, cụ thể bám sát mã nguồn thật (chỉ bọc backtick tên hàm có trong code_map)",
          },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
    markdown: {
      type: "string",
      description:
        "Nội dung tài liệu kỹ thuật đầy đủ định dạng Markdown bám sát code thật (tách riêng khỏi sơ đồ Mermaid)",
    },
    mermaid_diagram: {
      type: "string",
      nullable: true,
      description:
        "Mã sơ đồ Mermaid thuần túy (bắt đầu bằng sequenceDiagram hoặc flowchart TD/LR, không bọc trong ```mermaid)",
    },
    source_node_ids: {
      type: "array",
      items: { type: "string" },
      description: "Danh sách các node_id có thật từ code_map mà tài liệu này mô tả",
    },
  },
  required: ["title", "specs", "markdown", "mermaid_diagram", "source_node_ids"],
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
  specs: z.array(DocSpecItemSchema).optional(),
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
