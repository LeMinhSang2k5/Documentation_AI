import assert from "node:assert/strict";
import test from "node:test";
import {
  generateDocumentWithSelfCheck,
  kiem_tra_cu_phap_so_do,
  LLMClient,
  verifyDocument,
  xem_ham_lien_quan,
} from "../src/ai_harness/index.js";
import type { CodeMapNode } from "../src/types/index.js";

const SAMPLE_CODE_MAP: CodeMapNode[] = [
  {
    node_id: "fn_src_services_auth_service_login",
    name: "AuthService.login",
    file_path: "src/services/authService.ts",
    start_line: 10,
    end_line: 20,
    calls: ["fn_src_services_auth_service_find_user", "fn_src_utils_jwt_sign"],
  },
  {
    node_id: "fn_src_services_auth_service_find_user",
    name: "AuthService.findUserByEmail",
    file_path: "src/services/authService.ts",
    start_line: 22,
    end_line: 26,
    calls: [],
  },
  {
    node_id: "fn_src_utils_jwt_sign",
    name: "signJwtToken",
    file_path: "src/utils/jwtHelper.ts",
    start_line: 1,
    end_line: 5,
    calls: [],
  },
];

test("kiem_tra_cu_phap_so_do: chấp nhận flowchart và sequenceDiagram chuẩn", () => {
  const validFlow = kiem_tra_cu_phap_so_do(
    'flowchart TD\n  A["Nhận yêu cầu (Login)"] -->|"hợp lệ"| B["Ký JWT"]'
  );
  assert.equal(validFlow.valid, true);
  assert.equal(validFlow.errors.length, 0);
  assert.ok(validFlow.mermaidLiveUrl.startsWith("https://mermaid.live/edit#pako:"));

  const validSeq = kiem_tra_cu_phap_so_do(
    'sequenceDiagram\n  participant Client\n  participant Auth as "AuthService (API)"\n  Client->>Auth: Gọi login()\n  Auth-->>Client: Trả JWT'
  );
  assert.equal(validSeq.valid, true);
});

test("kiem_tra_cu_phap_so_do: bắt trúng lỗi ngoặc tròn thiếu ngoặc kép và mũi tên sai", () => {
  const broken = kiem_tra_cu_phap_so_do(
    "flowchart TD\n  A[Xác thực người dùng (AuthService.login)] --> B: Trả token"
  );
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.length >= 2);
});

test("verifyDocument: phát hiện chính xác tên hàm AI tự bịa và source_node_ids giả", () => {
  const result = verifyDocument(
    {
      markdown:
        "Hàm `AuthService.login` xác thực xong sẽ gọi `AuditService.recordLogin` và `fakeHelper()` để lưu log.",
      mermaid_diagram: 'flowchart TD\n  A["Login"] --> B["Done"]',
      source_node_ids: ["fn_src_services_auth_service_login", "fn_non_existent"],
    },
    SAMPLE_CODE_MAP
  );

  assert.equal(result.passed, false);
  assert.deepEqual(result.invalidSourceNodeIds, ["fn_non_existent"]);
  assert.ok(result.hallucinatedSymbols.includes("AuditService.recordLogin"));
  assert.ok(result.hallucinatedSymbols.includes("fakeHelper"));
});

test("xem_ham_lien_quan: tra cứu đúng cả chiều gọi đi (callsTo) và chiều bị gọi (calledBy)", () => {
  const rel = xem_ham_lien_quan("fn_src_utils_jwt_sign", SAMPLE_CODE_MAP);
  assert.equal(rel.found, true);
  assert.equal(rel.callsTo.length, 0);
  assert.equal(rel.calledBy.length, 1);
  assert.equal(rel.calledBy[0]?.node_id, "fn_src_services_auth_service_login");
});

test("generateDocumentWithSelfCheck: tự phát hiện lỗi Mermaid ở lần 1 và sửa thành công ở lần 2", async () => {
  const llm = new LLMClient({ provider: "mock" });
  const res = await generateDocumentWithSelfCheck({
    llm,
    docId: "doc_auth",
    docPath: "modules/authService.md",
    targetFilePath: "src/services/authService.ts",
    sourceContent: "export class AuthService { async login() {} }",
    codeMap: SAMPLE_CODE_MAP,
    maxRetries: 3,
  });

  assert.equal(res.initialMermaidValid, false);
  assert.equal(res.attemptsUsed, 2);
  assert.equal(res.finalVerification.passed, true);
  assert.equal(res.finalVerification.mermaidCheck.valid, true);
});
