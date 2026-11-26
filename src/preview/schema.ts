import { z } from "zod";

/** Schema kết quả job trả cho Nhóm 2.2 (GET /api/v1/docs/jobs/{job_id}). */
export const codeMapNodeSchema = z.object({
  node_id: z.string().min(1),
  name: z.string().min(1),
  file_path: z.string().min(1),
  start_line: z.number().int(),
  end_line: z.number().int(),
  calls: z.array(z.string()),
});

export const docItemSchema = z.object({
  doc_id: z.string().min(1),
  title: z.string(),
  path: z.string().min(1),
  markdown: z.string(),
  mermaid_diagram: z.string().nullable().optional().transform((v) => v ?? null),
  source_node_ids: z.array(z.string()),
});

export const resultSchema = z.object({
  job_id: z.string().optional().default("local"),
  status: z.string().optional().default("done"),
  commit_sha: z.string().optional().default(""),
  code_map: z.array(codeMapNodeSchema),
  documents: z.array(docItemSchema),
});

export type PreviewResult = z.infer<typeof resultSchema>;
