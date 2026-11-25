-- Supabase Schema cho Nhóm 2.1 (Code Documentation Generator)
-- LƯU Ý: Project Supabase này thuộc vùng lưu trữ riêng của Nhóm 2.1, không dùng chung với Nhóm 2.2.

create table if not exists public.doc_jobs (
  job_id text primary key,
  repo_url text not null,
  branch text not null default 'main',
  commit_sha text,
  changed_files jsonb not null default '[]'::jsonb,
  status text not null check (status in ('processing', 'done', 'failed')),
  result_path text,
  code_map jsonb,
  documents jsonb,
  metadata jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_doc_jobs_status on public.doc_jobs (status);
create index if not exists idx_doc_jobs_repo_url on public.doc_jobs (repo_url);

-- Bắt buộc bật RLS và KHÔNG mở policy public cho anon;
-- Chỉ backend Nhóm 2.1 dùng SUPABASE_SERVICE_ROLE_KEY mới được đọc/ghi.
alter table public.doc_jobs enable row level security;
