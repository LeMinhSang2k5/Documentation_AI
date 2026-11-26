import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_STRUCTURED_JSON_PROMPT,
  executeHarnessTool,
  generateDocumentWithSelfCheck,
  HARNESS_GEMINI_TOOL_DECLARATIONS,
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
    start_line: 1,
    end_line: 4,
    calls: ["fn_src_services_auth_service_find_user", "fn_src_utils_jwt_sign"],
  },
  {
    node_id: "fn_src_services_auth_service_find_user",
    name: "AuthService.findUserByEmail",
    file_path: "src/services/authService.ts",
    start_line: 5,
    end_line: 7,
    calls: [],
  },
  {
    node_id: "fn_src_utils_jwt_sign",
    name: "signJwtToken",
    file_path: "src/utils/jwtHelper.ts",
    start_line: 1,
    end_line: 3,
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

test("verifyDocument: phát hiện chính xác tên hàm AI tự bịa trong cả markdown lẫn specs [{ key, value }]", () => {
  const result = verifyDocument(
    {
      specs: [
        {
          key: "Luồng gọi hàm",
          value: "Sau khi đăng nhập sẽ gọi `GhostService.syncCloud()` để lưu phiên.",
        },
      ],
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
  assert.ok(result.hallucinatedSymbols.includes("GhostService.syncCloud"));
});

test("xem_ham_lien_quan & executeHarnessTool: đăng ký đủ 3 tool cho Gemini và đọc chéo file thật", async () => {
  assert.equal(HARNESS_GEMINI_TOOL_DECLARATIONS.length, 3);
  assert.deepEqual(
    HARNESS_GEMINI_TOOL_DECLARATIONS.map((t) => t.name),
    ["doc_ma_nguon_ham", "xem_ham_lien_quan", "kiem_tra_cu_phap_so_do"]
  );

  const rel = xem_ham_lien_quan("fn_src_utils_jwt_sign", SAMPLE_CODE_MAP);
  assert.equal(rel.found, true);
  assert.equal(rel.callsTo.length, 0);
  assert.equal(rel.calledBy.length, 1);
  assert.equal(rel.calledBy[0]?.node_id, "fn_src_services_auth_service_login");

  const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "docgen-tool-test-"));
  try {
    await fs.mkdir(path.join(tmpRepo, "src", "utils"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRepo, "src", "utils", "jwtHelper.ts"),
      "export function signJwtToken(id: string) {\n  return `jwt_${id}`;\n}\n",
      "utf-8"
    );

    const readOut = await executeHarnessTool(
      "doc_ma_nguon_ham",
      { node_id: "fn_src_utils_jwt_sign" },
      { codeMap: SAMPLE_CODE_MAP, repoDir: tmpRepo }
    );
    assert.equal(readOut.found, true);
    assert.match(String(readOut.content), /signJwtToken/);

    const mermaidOut = await executeHarnessTool(
      "kiem_tra_cu_phap_so_do",
      { mermaid_code: 'flowchart LR\n  A["Start"] --> B["End"]' },
      { codeMap: SAMPLE_CODE_MAP, repoDir: tmpRepo }
    );
    assert.equal(mermaidOut.valid, true);
  } finally {
    await fs.rm(tmpRepo, { recursive: true, force: true });
  }
});

test("DEFAULT_STRUCTURED_JSON_PROMPT & generateDocumentWithSelfCheck: chế độ codeMapOnly (không truyền sourceContent) vẫn tự gọi tool và sinh đủ specs [{ key, value }]", async () => {
  assert.match(DEFAULT_STRUCTURED_JSON_PROMPT, /LIST \[<key, value>\]/i);

  const llm = new LLMClient({ provider: "mock" });
  const res = await generateDocumentWithSelfCheck({
    llm,
    docId: "doc_auth",
    docPath: "modules/authService.md",
    targetFilePath: "src/services/authService.ts",
    codeMapOnly: true,
    codeMap: SAMPLE_CODE_MAP,
    fullRepoCodeMap: SAMPLE_CODE_MAP,
    enableTools: true,
    maxRetries: 3,
  });

  assert.equal(res.initialMermaidValid, false);
  assert.equal(res.attemptsUsed, 2);
  assert.equal(res.finalVerification.passed, true);
  assert.equal(res.finalVerification.mermaidCheck.valid, true);
  assert.ok((res.document.specs?.length ?? 0) >= 5, "Expected >= 5 detailed key-value specs");
  assert.ok(res.toolCallsCount >= 3, "Expected Tool Calling to execute during generation");
});
