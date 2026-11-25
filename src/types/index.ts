export type JobStatus = "processing" | "done" | "failed";

export interface CodeMapNode {
  node_id: string;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  calls: string[];
}

export interface DocItem {
  doc_id: string;
  title: string;
  path: string;
  markdown: string;
  mermaid_diagram: string | null;
  source_node_ids: string[];
}

export interface JobError {
  code: string;
  message: string;
}

export interface AnalyzeRequest {
  repo_url: string;
  branch: string;
  commit_sha: string | null;
  changed_files: string[];
}

export interface SampleOutputData {
  job_id?: string;
  status?: "done";
  commit_sha: string;
  code_map: CodeMapNode[];
  documents: DocItem[];
}

export interface LocalJobResult {
  job_id: string;
  status: "done";
  commit_sha: string;
  code_map: CodeMapNode[];
  documents: DocItem[];
}

export interface JobRecord {
  job_id: string;
  repo_url: string;
  branch: string;
  commit_sha: string | null;
  changed_files: string[];
  status: JobStatus;
  result_path: string | null;
  code_map: CodeMapNode[] | null;
  documents: DocItem[] | null;
  metadata: Record<string, unknown>;
  error: JobError | null;
  created_at: string;
  updated_at: string;
}

export type NewJobRecord = Omit<JobRecord, "created_at" | "updated_at">;

export type JobPatch = Partial<
  Pick<
    JobRecord,
    | "commit_sha"
    | "status"
    | "result_path"
    | "code_map"
    | "documents"
    | "metadata"
    | "error"
  >
>;

// --- Parser Types (Tree-sitter -> code_map contract) ---

export interface ParsedFunction {
  name: string;
  kind: "function" | "method" | "arrow_function";
  class_name?: string;
  start_line: number;
  end_line: number;
  params: string[];
  is_exported: boolean;
  raw_calls: string[];
}

export interface ParsedImport {
  source: string;
  imported_names: string[];
  default_import?: string;
  namespace_import?: string;
}

export interface ParsedFile {
  file_path: string;
  has_syntax_error: boolean;
  imports: ParsedImport[];
  functions: ParsedFunction[];
}
