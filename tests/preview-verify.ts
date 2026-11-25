/**
 * Tự kiểm thử CLI preview: validator (markdown + mermaid + code_map + AI Harness self-check) và renderer.
 * Chạy: npm run test:preview
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderDocPage, renderIndexPage } from "../src/preview/renderer.js";
import { checkSchema, runHarnessCheck, validateMarkdown, validateMermaid, validateResult } from "../src/preview/validator.js";

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}`);
    throw err;
  }
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

console.log("validateMermaid");
await check("accepts a valid flowchart", async () => {
  const r = await validateMermaid("flowchart LR\n  A --> B");
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});
await check("accepts sequence / class / er diagrams", async () => {
  for (const code of ["sequenceDiagram\n  A->>B: hi", "classDiagram\n  class A", "erDiagram\n  A ||--o{ B : has"]) {
    assert.equal((await validateMermaid(code)).ok, true, code);
  }
});
await check("rejects a syntax error with its line number", async () => {
  const r = await validateMermaid("flowchart LR\n  A --> B\n  B -->");
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r.issues), ["MERMAID_SYNTAX"]);
});
await check("rejects unknown diagram types", async () => {
  assert.equal((await validateMermaid("notADiagram\n A")).ok, false);
});
await check("warns on ```mermaid fences but still parses the inside", async () => {
  const r = await validateMermaid("```mermaid\nflowchart LR\n  A --> B\n```");
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r.issues), ["MERMAID_FENCED"]);
});
await check("rejects an empty diagram", async () => {
  assert.deepEqual(codes((await validateMermaid("   ")).issues), ["MERMAID_EMPTY"]);
});

console.log("validateMarkdown");
await check("clean markdown has no issues", async () => {
  const r = await validateMarkdown("# Title\n\nText with `code`.\n\n## Section\n\n```ts\nconst a = 1;\n```\n");
  assert.deepEqual(r.issues, []);
});
await check("detects unclosed code fence", async () => {
  const r = await validateMarkdown("# T\n\n```ts\nconst a = 1;\n");
  assert.deepEqual(codes(r.issues), ["MD_UNCLOSED_FENCE"]);
  assert.equal(r.issues[0]?.line, 3);
});
await check("ignores headings inside code blocks", async () => {
  const r = await validateMarkdown("# T\n\n```md\n#### not a heading\n```\n");
  assert.deepEqual(r.issues, []);
});
await check("detects heading jumps, missing space and no heading", async () => {
  assert.deepEqual(codes((await validateMarkdown("# A\n\n### B\n")).issues), ["MD_HEADING_SKIP"]);
  assert.deepEqual(codes((await validateMarkdown("# A\n\n##B\n")).issues), ["MD_HEADING_NO_SPACE"]);
  assert.deepEqual(codes((await validateMarkdown("just text\n")).issues), ["MD_NO_HEADING"]);
});
await check("validates embedded ```mermaid blocks with markdown line numbers", async () => {
  const r = await validateMarkdown("# T\n\n```mermaid\nflowchart LR\n  A -->\n```\n");
  assert.deepEqual(codes(r.issues), ["MERMAID_SYNTAX"]);
  assert.equal(r.mermaid.length, 1);
  assert.equal(r.mermaid[0]?.ok, false);
});
await check("detects empty and javascript: links", async () => {
  const r = await validateMarkdown("# T\n\n[a]() and [b](javascript:alert(1))\n");
  assert.deepEqual(codes(r.issues).sort(), ["MD_EMPTY_LINK", "MD_UNSAFE_LINK"]);
});
await check("detects links to documents that do not exist", async () => {
  const r = await validateMarkdown("# T\n\n[ok](../overview.md) [bad](./missing.md#x)\n", {
    docPath: "modules/auth.md",
    knownDocPaths: new Set(["overview.md", "modules/auth.md"]),
  });
  assert.deepEqual(codes(r.issues), ["MD_BROKEN_DOC_LINK"]);
  assert.match(r.issues[0]?.message ?? "", /modules\/missing\.md/);
});

console.log("runHarnessCheck (AI Harness verifyDocument)");
const harnessCodeMap = [
  { node_id: "fn_login", name: "AuthService.login", file_path: "src/auth.ts", start_line: 1, end_line: 9, calls: [] },
];
await check("passes a document that only names real symbols", () => {
  const h = runHarnessCheck(
    { doc_id: "d", title: "T", path: "d.md", markdown: "# T\n\n`AuthService.login()`", mermaid_diagram: null, source_node_ids: ["fn_login"] },
    harnessCodeMap
  );
  assert.equal(h.passed, true);
  assert.equal(h.referenced_symbols, 1);
  assert.equal(h.mermaid.checked, false);
  assert.equal(h.mermaid.live_url, null);
});
await check("flags hallucinated symbols and unknown source_node_ids", () => {
  const h = runHarnessCheck(
    { doc_id: "d", title: "T", path: "d.md", markdown: "# T\n\n`AuthService.login()` `made_up()`", mermaid_diagram: null, source_node_ids: ["fn_ghost"] },
    harnessCodeMap
  );
  assert.equal(h.passed, false);
  assert.deepEqual(h.hallucinated_symbols, ["made_up"]);
  assert.deepEqual(h.invalid_source_node_ids, ["fn_ghost"]);
});
await check("runs kiem_tra_cu_phap_so_do on the diagram and links mermaid.live", () => {
  const h = runHarnessCheck(
    { doc_id: "d", title: "T", path: "d.md", markdown: "# T", mermaid_diagram: "flowchart TD\n  A --> B: label", source_node_ids: [] },
    harnessCodeMap
  );
  assert.equal(h.passed, false);
  assert.equal(h.mermaid.valid, false);
  assert.ok(h.mermaid.errors.length > 0);
  assert.match(h.mermaid.live_url ?? "", /^https:\/\/mermaid\.live\/edit#pako:/);
});

console.log("validateResult + schema");
const fixture = JSON.parse(await readFile(new URL("./fixtures/preview-sample.json", import.meta.url), "utf8"));

await check("schema rejects malformed results", () => {
  const r = checkSchema({ code_map: [{ node_id: "x" }], documents: "nope" });
  assert.equal(r.result, undefined);
  assert.ok(r.issues.length >= 2);
});
const schema = checkSchema(fixture);
assert.ok(schema.result, "fixture must match schema");
const report = await validateResult(schema.result);

await check("fixture report has the expected findings", () => {
  assert.deepEqual(codes(report.global), ["CODEMAP_UNKNOWN_CALL"]);
  const [overview, auth] = report.documents;
  assert.deepEqual(codes(overview?.issues ?? []), ["MD_BROKEN_DOC_LINK"]);
  assert.deepEqual(codes(auth?.issues ?? []).sort(), [
    "DOC_UNKNOWN_NODE",
    "HALLUCINATED_SYMBOL",
    "HARNESS_MERMAID",
    "MD_HEADING_SKIP",
    "MD_UNCLOSED_FENCE",
    "MERMAID_FENCED",
    "MERMAID_SYNTAX",
  ]);
  assert.equal(overview?.harness.passed, true);
  assert.equal(auth?.harness.passed, false);
  assert.deepEqual(auth?.harness.hallucinated_symbols, ["hashPassword"]);
  assert.equal(report.summary.mermaid_total, 3);
  assert.equal(report.summary.mermaid_ok, 2);
  assert.equal(report.summary.errors, 4);
  assert.equal(report.summary.harness_passed, 1);
  assert.equal(report.summary.hallucinated_symbols, 1);
  assert.equal(report.summary.hallucination_rate, 20);
});

console.log("renderDocPage / renderIndexPage");
const result = schema.result;
const docReports = new Map(report.documents.map((d) => [d.doc_id, d]));
const [overviewDoc, authDoc] = result.documents;
assert.ok(overviewDoc && authDoc);
const overviewHtml = await renderDocPage({ job: result, doc: overviewDoc, report: docReports.get(overviewDoc.doc_id), jobReport: report });
const authHtml = await renderDocPage({ job: result, doc: authDoc, report: docReports.get(authDoc.doc_id), jobReport: report });

await check("doc page has Markdown / Mermaid / source / issues / summary tabs", () => {
  for (const tab of ["markdown", "mermaid", "source", "issues", "summary"]) {
    assert.ok(overviewHtml.includes(`data-tab="${tab}"`), tab);
    assert.ok(overviewHtml.includes(`data-panel="${tab}"`), tab);
  }
});
await check("escapes raw HTML from markdown", () => {
  assert.ok(!authHtml.includes("<script>alert('xss')</script>"));
  assert.ok(authHtml.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"));
});
await check("relative .md links point to the sibling preview file", () => {
  assert.ok(overviewHtml.includes('href="doc_auth_module.html"'));
  assert.ok(authHtml.includes('href="doc_overview.html"'));
  assert.match(overviewHtml, /class="bad-link" title="Không tìm thấy modules\/payment\.md"/);
});
await check("Mermaid tab lists mermaid_diagram and embedded blocks, without ``` fences", () => {
  const panel = overviewHtml.slice(overviewHtml.indexOf('data-panel="mermaid"'), overviewHtml.indexOf('data-panel="source"'));
  assert.equal((panel.match(/<pre class="mermaid">/g) ?? []).length, 2);
  assert.ok(!/<pre class="mermaid">```/.test(authHtml));
  assert.ok(overviewHtml.includes("API &lt;b&gt;Gateway&lt;/b&gt;"));
});
await check("issues tab shows the AI harness verdict and findings", () => {
  assert.ok(authHtml.includes("AI Harness self-check: Không đạt"));
  assert.ok(overviewHtml.includes("AI Harness self-check: Đạt"));
  assert.ok(authHtml.includes("<code>hashPassword</code>"));
  assert.ok(authHtml.includes("https://mermaid.live/edit#pako:"));
  assert.ok(authHtml.includes("MERMAID_SYNTAX"));
  assert.ok(authHtml.includes("DOC_UNKNOWN_NODE"));
  assert.ok(overviewHtml.includes("MD_BROKEN_DOC_LINK"));
});
await check("Markdown tab switches between beautified and raw markdown", () => {
  assert.ok(authHtml.includes('data-md-mode="pretty"') && authHtml.includes('data-md-mode="raw"'));
  assert.match(authHtml, /<article class="markdown-body" data-md-view="pretty">/);
  assert.match(authHtml, /<pre class="raw" data-md-view="raw" hidden><code>## Luồng đăng nhập/);
});
await check("header shows harness, hallucination and diagram stats", () => {
  assert.ok(authHtml.includes("AI Harness: Không đạt"));
  assert.ok(authHtml.includes("Bịa tên: 1/3"));
  assert.ok(overviewHtml.includes("Sơ đồ: 2/2 hiển thị được"));
});
await check("summary tab shows the whole result: job info, metrics, documents, code_map, raw JSON", () => {
  const panel = authHtml.slice(authHtml.indexOf('data-panel="summary"'));
  assert.ok(panel.includes("<code>doc_job_preview_fixture</code>"));
  assert.ok(panel.includes("<code>a1b2c3d4</code>"));
  assert.ok(panel.includes(">20%<"));
  assert.ok(panel.includes(">1/2<"));
  assert.ok(panel.includes('href="doc_overview.html"'));
  assert.ok(panel.includes("CODEMAP_UNKNOWN_CALL"));
  assert.ok(panel.includes("UserRepository.findByEmail"));
  assert.ok(panel.includes('title="Không có trong code_map">fn_missing_helper'));
  assert.ok(panel.includes("result.json gốc"));
});
await check("embedded CSS has no terminal escape codes", () => {
  assert.ok(!overviewHtml.includes("\u001b"));
  assert.ok(overviewHtml.includes(".segmented button.active"));
});
await check("loads mermaid from a pinned CDN version", () => {
  assert.match(overviewHtml, /cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.min\.js/);
});
await check("index links every doc into the viewer frame", async () => {
  const index = await renderIndexPage([
    { job: result, dir: "doc_job_preview_fixture", reports: docReports },
  ]);
  assert.ok(!index.includes("Bịa tên"), "sidebar chỉ hiện tên job, số liệu nằm ở main content");
  // Sidebar ghi tên job (job_id) thay cho tiêu đề tài liệu.
  assert.equal((index.match(/<span class="nav-title">doc_job_preview_fixture<\/span>/g) ?? []).length, 2);
  assert.ok(!index.includes('<span class="nav-title">Tổng quan kiến trúc</span>'));
  assert.ok(index.includes('href="doc_job_preview_fixture/doc_overview.html" target="viewer"'));
  assert.ok(index.includes('href="doc_job_preview_fixture/doc_auth_module.html" target="viewer"'));
  assert.ok(index.includes('<iframe class="viewer" name="viewer"'));
  assert.ok(index.includes('src="doc_job_preview_fixture/doc_overview.html"'));
});

console.log(`\n${passed} checks passed`);
