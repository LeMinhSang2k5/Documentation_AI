# Code Documentation Generator — Nhóm 2.1 (HTTP API)

Hệ thống phân tích mã nguồn, sinh tài liệu kỹ thuật kèm sơ đồ Mermaid và cung cấp kết quả qua HTTP API cho Nhóm 2.2.

## 1. Yêu cầu môi trường
- **Node.js** `>= 20`
- **Project Supabase** riêng của Nhóm 2.1

## 2. Cài đặt nhanh

```bash
npm install
cp .env.example .env
```

1. Mở **Supabase SQL Editor** của Nhóm 2.1, copy toàn bộ nội dung file `supabase/schema.sql` và bấm **Run** để tạo bảng `public.doc_jobs` (có bật RLS).
2. Điền thông tin thật vào file `.env` (không commit `.env` lên Git):
   ```env
   PORT=3000
   API_KEY=<chuoi-bi-mat-chia-se-voi-nhom-2.2>
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key-cua-nhom-2.1>
   ```

## 3. Chạy server & Kiểm tra

```bash
# Chạy chế độ phát triển (tự reload khi sửa code)
npm run dev

# Kiểm tra kiểu TypeScript
npm run typecheck

# Tự kiểm thử tự động toàn bộ 6 kịch bản API + cơ chế lưu file local & fallback backup Supabase
npm run test:api
```

## 4. Tài liệu liên quan
- Hợp đồng API bàn giao Nhóm 2.2: `doc/api-contract.md`
- File JSON kết quả mẫu: `src/data/sample-output.json`
- Kế hoạch HTTP API Tuần 1: `doc/week1/http-api-plan.md`
