# Sơ đồ Luồng Dữ liệu Giao tiếp HTTP API giữa Nhóm 2.1 và Nhóm 2.2

Tài liệu dùng để thống nhất hợp đồng giao tiếp cuối Tuần 1 giữa **Nhóm 2.1 (Code Documentation Generator)** và **Nhóm 2.2 (Cổng xem tài liệu & Hỏi đáp mã nguồn)**.

```mermaid
sequenceDiagram
  participant User as "Người dùng cuối"
  participant G22 as "Nhóm 2.2 (Portal & Q&A - DB riêng)"
  participant API21 as "Nhóm 2.1 HTTP API (X-API-Key)"
  participant Parser as "Nhóm 2.1 Tree-sitter Parser"
  participant Harness as "Nhóm 2.1 AI Harness"

  User->>G22: Nhập link GitHub + branch/commit
  G22->>API21: POST /api/v1/docs/analyze (repo_url, branch, commit_sha, changed_files)
  API21-->>G22: 202 Accepted { job_id: "doc_job_2026_001", status: "processing" }
  API21->>Parser: Clone repo & quét AST tạo code_map
  Parser-->>Harness: Danh sách CodeMapNode (node_id, start_line, end_line, calls)
  Harness->>Harness: Sinh tài liệu theo tầng + Self-check (check tên hàm & Mermaid <= 3 lần)
  Harness-->>API21: Lưu bộ kết quả { code_map, documents } theo job_id
  loop Polling định kỳ
    G22->>API21: GET /api/v1/docs/jobs/doc_job_2026_001 (Header X-API-Key)
    API21-->>G22: 200 OK { status: "done", commit_sha, code_map, documents }
  end
  G22->>User: Hiển thị Markdown + Sơ đồ Mermaid & liên kết dòng code theo source_node_ids
```

## Thông tin bộ mẫu đã xuất kèm
- **Dự án mẫu:** `https://github.com/LeMinhSang2k5/TodoAppCloud`
- **Commit SHA:** `58629bb`
- **File JSON mẫu:** `experiments/results/sample_for_group_2_2.json`
