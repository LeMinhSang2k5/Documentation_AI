# Báo cáo Khảo sát Lỗi Sinh Tài liệu & Sơ đồ của AI — Tuần 1 (Nhóm 2.1)

## 1. Thông tin thực nghiệm khảo sát (Bản thô `v1` — Phương án A)
- **Nguồn dữ liệu khảo sát:** `https://github.com/LeMinhSang2k5/TodoAppCloud` *(đối chiếu với `code_map` quét bằng Tree-sitter thật của nhóm)*
- **Provider / Model:** `gemini` / `gemini-flash-lite-latest`
- **Số file gửi rời rạc:** 4 file (không cung cấp `code_map` cho AI, không bật vòng tự kiểm tra)
- **Tổng lượng token tiêu thụ:** 6374 tokens (Prompt: 2907, Completion: 3467)
- **Tỷ lệ sơ đồ Mermaid hợp lệ ngay lần đầu trên `mermaid.live`:** **25%** (1/4 sơ đồ lên hình ngay, **3/4 sơ đồ dính lỗi cú pháp**)
- **Tỷ lệ tên hàm nghi vấn ngoài `code_map`:** **66.67%** (16/24 định danh hàm được nhắc tới)

---

## 2. Bảng thống kê lỗi chi tiết từng file (Kiểm chứng thực tế trên `mermaid.live`)

| STT | File khảo sát | Các hàm Tree-sitter quét được | Tên hàm ngoài `code_map` / bịa | Kiểm tra trên `mermaid.live` | Chi tiết lỗi cú pháp ghi nhận |
| :---: | :--- | :--- | :--- | :---: | :--- |
| 1 | `src/hooks/useSettings.js` (98 dòng) | `useSettings` | Có (`reload`, `saveSettings`, `saveAccount`, `exportBackup`) | **Lỗi cú pháp (Fail)** | `sequenceDiagram` dùng ký tự đặc biệt `/`, `{ settings }` và điều kiện `alt` / `else` tiếng Việt không bọc ngoặc kép gây `Parse error` trên `mermaid.live`. |
| 2 | `src/api/client.js` (63 dòng) | `getToken`, `request`, `saveAuth`, `clearAuth`, `loadSavedAuth` | Có (`res.ok`, `api.get`, `JSON.stringify`, `api.delete`) | **Lỗi cú pháp (Fail)** | Dòng 9–10: Nhãn trên mũi tên `I -- Sai (Not OK) --> J` và nhãn `[Hàm request path, options]` không bọc ngoặc kép `"..."` làm lỗi dấu `()`. |
| 3 | `src/hooks/useTasks.js` (52 dòng) | `useTasks` | Có (`options.addToBottom`, `reload`, `addTask`, `toggleTask`, `deleteTask`) | **Lỗi cú pháp (Fail)** | Dòng 4: Nhãn `[Call reload()]` đặt dấu ngoặc tròn `()` bên trong `[]` nhưng không bọc ngoặc kép `"..."`. |
| 4 | `src/hooks/useProjects.js` (46 dòng) | `useProjects` | Có (`reload`, `addProject`, `deleteProject`) | **Hợp lệ (Pass)** | Lên hình thành công trên `mermaid.live`. |

---

## 3. Đối chiếu mã Mermaid trên `mermaid.live`: Bản thô `v1` (Lỗi) vs Bản sau khi AI Harness chuẩn hóa (Vẽ thành công 100%)

> **Hướng dẫn copy sang [https://mermaid.live/edit](https://mermaid.live/edit):** Các khung bên dưới để ở định dạng văn bản thuần (`text`) để khi bạn copy dán sang `mermaid.live` không bị dính ký tự khoảng trắng ẩn (`NBSP`).

### File 1 — `src/hooks/useSettings.js`

**A. Bản thô `v1` do AI tự sinh (Dán vào `mermaid.live` sẽ báo đỏ Syntax Error):**
```text
sequenceDiagram
    autonumber
    participant UI as React Component
    participant Hook as useSettings Hook
    participant API as Backend API
    participant LS as LocalStorage / DOM
    UI->>Hook: useSettings(isAuthenticated = true)
    Hook->>API: GET /settings
    alt Thành công
        API-->>Hook: Trả về settings & user data
        Hook-->>UI: Cập nhật state (settings, account, loading=false)
    else Thất bại
        API-->>Hook: Trả về lỗi
        Hook-->>UI: Cập nhật error message
    end
    UI->>Hook: saveSettings(nextSettings)
    Hook->>API: PATCH /settings { settings }
```

**B. Bản sau khi qua AI Harness (`verifier.ts` bọc ngoặc kép chuẩn — Dán vào `mermaid.live` lên hình đẹp 100%):**
```text
flowchart TD
    Start["useSettings(isAuthenticated)"] --> CheckAuth{"isAuthenticated?"}
    CheckAuth -- "true" --> Reload["reload(): Gọi GET /settings"]
    CheckAuth -- "false" --> Idle["Không tải"]
    Reload --> ApplyTheme["mergeClientSettings & applyThemeMode"]
    Start --> SaveSet["saveSettings(nextSettings)"]
    SaveSet --> PatchSet["PATCH /settings"]
    PatchSet --> ApplyTheme
    Start --> SaveAcc["saveAccount(payload)"]
    SaveAcc --> PatchAcc["PATCH /settings/account"]
    PatchAcc --> CallSaveAuth["saveAuth(token, user)"]
    Start --> Export["exportBackup()"]
    Export --> DownloadFile["Tải taskflow-sao-luu.json"]
```

---

### File 2 — `src/api/client.js`

**A. Bản thô `v1` do AI tự sinh (Lỗi dòng `-- Sai (Not OK) -->` thiếu ngoặc kép):**
```text
flowchart TD
    A[Client gọi api.get / post / ...] --> B[Hàm request path, options]
    B --> C[Lấy token từ localStorage]
    C --> D[Xây dựng Headers: Content-Type, Authorization]
    D --> E[Gọi fetch BASE + path, options + headers]
    E --> F{Kiểm tra res.status}
    F -- status === 204 --> G[Trả về null]
    F -- Khác 204 --> H[Parse response sang JSON]
    H --> I{res.ok có thành công?}
    I -- Sai (Not OK) --> J[Tạo Error với message và status rồi throw]
    I -- Đúng (OK) --> K[Trả về dữ liệu data]
```

**B. Bản sau khi qua AI Harness (Đã bọc `"..."` an toàn — Dán vào `mermaid.live` lên hình đẹp 100%):**
```text
flowchart TD
    Start["Bắt đầu request(path, options)"] --> CallGetToken["Gọi getToken()"]
    CallGetToken --> BuildHeaders["Khởi tạo Headers kèm Bearer Token"]
    BuildHeaders --> FetchData["Thực hiện fetch"]
    FetchData --> Check204{"res.status == 204?"}
    Check204 -- "Có" --> ReturnNull["Trả về null"]
    Check204 -- "Không" --> ParseData["Phân tích res.json()"]
    ParseData --> CheckOK{"res.ok?"}
    CheckOK -- "Thành công" --> ReturnResult["Trả về data"]
    CheckOK -- "Thất bại" --> ThrowErr["Ném ngoại lệ Error"]
```

---

### File 3 — `src/hooks/useTasks.js`

**A. Bản thô `v1` do AI tự sinh (Lỗi dòng `C[Call reload()]` thiếu ngoặc kép):**
```text
flowchart TD
    subgraph Initialization
        A[Component Mounts] --> B{isAuthenticated?}
        B -- Yes --> C[Call reload()]
        C --> D[Set loading = true]
        D --> E[GET /tasks API]
        E -->|Success| F[Set tasks state]
        E -->|Error| G[Set error message]
        F & G --> H[Set loading = false]
        B -- No --> I[Skip]
    end
```

**B. Bản sau khi qua AI Harness (Đã bọc `"..."` an toàn — Dán vào `mermaid.live` lên hình đẹp 100%):**
```text
flowchart TD
    Start["useTasks(isAuthenticated, options)"] --> CheckAuth{"isAuthenticated?"}
    CheckAuth -- "true" --> Reload["reload(): GET /tasks"]
    CheckAuth -- "false" --> ClearList["Đặt danh sách rỗng"]
    Reload --> UpdateState["Cập nhật state tasks"]
    Start --> AddTask["addTask(payload): POST /tasks"]
    Start --> ToggleTask["toggleTask(id): PATCH /tasks/:id"]
    Start --> DeleteTask["deleteTask(id): DELETE /tasks/:id"]
```

---

### File 4 — `src/hooks/useProjects.js` *(Bản thô `v1` hợp lệ ngay từ đầu)*

```text
flowchart TD
    A["Component gọi useProjects"] --> B{"isAuthenticated?"}
    B -- "Không" --> C["Kết thúc, không gọi API"]
    B -- "Có" --> D["useEffect kích hoạt reload"]
    D --> E["Set loading = true"]
    E --> F["Gọi API: GET /projects"]
    F -- "Thành công" --> G["Set projects = response data"]
    F -- "Thất bại" --> H["Set error = err.message"]
    G --> I["Set loading = false"]
    H --> I
    I --> J["Sẵn sàng render UI & nhận các thao tác CRUD"]
```

---

## 4. Nhận xét & Định hướng thiết kế AI Harness (Tuần 2–5)
1. **Kết luận lớn về lỗi sơ đồ Mermaid ở Bản thô `v1`:**
   - Có tới **3/4 sơ đồ (75% lỗi, chỉ 25% thành công)** bị báo đỏ `Syntax error` trên `mermaid.live` khi để AI tự do sinh mã Mermaid mà không có quy tắc bọc ngoặc kép `"..."` và công cụ tự kiểm tra.
   - Sau khi đi qua **AI Harness (`verifier.ts` + `checkMermaid.ts`)**, tỷ lệ hiển thị thành công trên `mermaid.live` tăng từ **25% lên 100%**.
2. **Nhóm lỗi đối chiếu tên hàm (`code_map`):**
   - Các hàm con khai báo bên trong React Hook (`reload`, `addTask`, `toggleTask`) và các phương thức trong biến object (`api.get`, `api.delete`) chưa nằm trong `code_map` cấp ngoài cùng — cần phối hợp mở rộng cùng nhóm Tree-sitter ở Tuần 2.
