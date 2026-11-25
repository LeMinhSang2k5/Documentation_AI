import { readFile } from "node:fs/promises";
import { Marked, type Tokens } from "marked";
import type { CodeMapNode, DocItem } from "../types/index.js";
import { installedMermaidVersion } from "./mermaidEngine.js";
import type { PreviewResult } from "./schema.js";
import {
  resolveDocLink,
  type DocumentReport,
  type HarnessCheck,
  type ValidationIssue,
  type ValidationReport,
  type ValidationSummary,
} from "./validator.js";

const CSS_URL = new URL("./assets/preview.css", import.meta.url);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tên file an toàn cho một doc_id / job_id. */
export function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function docFileName(docId: string): string {
  const name = safeFileName(docId);
  // index.html là trang sidebar của job, nên tránh trùng tên.
  return `${name === "index" ? "doc_index" : name}.html`;
}

function stripFence(code: string): string {
  return /^\s*```+\s*mermaid\s*\n([\s\S]*?)\n\s*```+\s*$/i.exec(code)?.[1] ?? code;
}

function diagramBlock(code: string): string {
  return `<figure class="diagram"><pre class="mermaid">${escapeHtml(code)}</pre></figure>`;
}

/** Markdown -> HTML. HTML thô bị escape; link .md tương đối trỏ sang file preview của doc kia. */
function renderMarkdown(markdown: string, docPath: string, pathToDocId: Map<string, string>): string {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      code({ text, lang }: Tokens.Code) {
        if (lang && /^mermaid\b/i.test(lang)) return diagramBlock(text);
        return `<pre><code>${escapeHtml(text)}</code></pre>\n`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      link(token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens);
        let href = token.href.trim();
        if (/^\s*(javascript|vbscript|data):/i.test(href)) return inner;
        const external = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
        if (!external && !href.startsWith("#") && /\.md(?:[#?].*)?$/i.test(href)) {
          const targetId = pathToDocId.get(resolveDocLink(docPath, href));
          if (!targetId) return `<span class="bad-link" title="Không tìm thấy ${escapeHtml(href)}">${inner}</span>`;
          href = docFileName(targetId);
        }
        const target = external ? ` target="_blank" rel="noopener"` : "";
        return `<a href="${escapeHtml(href)}"${target}>${inner}</a>`;
      },
    },
  });
  return marked.parse(markdown, { async: false }) as string;
}

function countIssues(issues: ValidationIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
}

export function statusBadge(issues: ValidationIssue[]): string {
  const { errors, warnings } = countIssues(issues);
  if (errors) return `<span class="badge badge-error" title="${errors} lỗi">${errors}</span>`;
  if (warnings) return `<span class="badge badge-warn" title="${warnings} cảnh báo">${warnings}</span>`;
  return `<span class="badge badge-ok" title="Hợp lệ">✓</span>`;
}

function issuesPanel(issues: ValidationIssue[]): string {
  if (issues.length === 0) return `<p class="all-good">Không phát hiện lỗi nào.</p>`;
  const items = issues
    .map((i) => {
      const where = [i.field, i.line !== undefined ? `dòng ${i.line}` : ""].filter(Boolean).join(" · ");
      return `<li class="issue issue-${i.severity}">
  <span class="sev">${i.severity === "error" ? "Lỗi" : "Cảnh báo"}</span>
  <code class="issue-code">${escapeHtml(i.code)}</code>
  <span class="issue-where">${escapeHtml(where)}</span>
  <pre class="issue-msg">${escapeHtml(i.message)}</pre>
</li>`;
    })
    .join("\n");
  return `<ul class="issues">${items}</ul>`;
}

/** Thẻ tóm tắt kết quả self-check của AI Harness, đặt đầu tab Kiểm tra. */
function harnessCard(h: HarnessCheck | undefined): string {
  if (!h) return "";
  const list = (items: string[]) =>
    items.length ? items.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ") : `<span class="muted">không có</span>`;
  const mermaid = !h.mermaid.checked
    ? `<span class="muted">không có sơ đồ</span>`
    : h.mermaid.valid
      ? "hợp lệ"
      : `<span class="bad">${h.mermaid.errors.length} lỗi</span>`;
  const live = h.mermaid.live_url
    ? ` · <a href="${escapeHtml(h.mermaid.live_url)}" target="_blank" rel="noopener">mở trên mermaid.live</a>`
    : "";
  return `<section class="harness ${h.passed ? "harness-pass" : "harness-fail"}">
  <h2>AI Harness self-check: ${h.passed ? "Đạt" : "Không đạt"}</h2>
  <dl>
    <dt>Tên hàm/lớp được nhắc</dt><dd>${h.referenced_symbols}</dd>
    <dt>Tên bịa (không có trong code_map)</dt><dd>${list(h.hallucinated_symbols)}</dd>
    <dt>source_node_ids sai</dt><dd>${list(h.invalid_source_node_ids)}</dd>
    <dt>Sơ đồ (kiem_tra_cu_phap_so_do)</dt><dd>${mermaid}${live}</dd>
  </dl>
</section>`;
}

/** Số liệu của tài liệu ngay dưới tiêu đề: AI Harness, bịa tên, sơ đồ. */
function docStats(report: DocumentReport | undefined): string {
  if (!report) return "";
  const h = report.harness;
  const diagrams = report.mermaid;
  const ok = diagrams.filter((d) => d.ok).length;
  const chip = (tone: string, text: string) => `<span class="chip chip-${tone}">${escapeHtml(text)}</span>`;
  return `<div class="chips">
  ${chip(h.passed ? "ok" : "error", `AI Harness: ${h.passed ? "Đạt" : "Không đạt"}`)}
  ${chip(h.hallucinated_symbols.length ? "error" : "ok", `Bịa tên: ${h.hallucinated_symbols.length}/${h.referenced_symbols}`)}
  ${diagrams.length ? chip(ok < diagrams.length ? "error" : "ok", `Sơ đồ: ${ok}/${diagrams.length} hiển thị được`) : chip("plain", "Không có sơ đồ")}
</div>`;
}

/** Một dòng số liệu của job: tỉ lệ bịa tên, sơ đồ hiển thị được, số tài liệu qua harness. */
export function summaryLine(s: ValidationSummary): string {
  return [
    `Bịa tên ${s.hallucination_rate}% (${s.hallucinated_symbols}/${s.referenced_symbols})`,
    `Sơ đồ ${s.mermaid_ok}/${s.mermaid_total}`,
    `Harness đạt ${s.harness_passed}/${s.documents}`,
  ].join(" · ");
}

function sourcePanel(doc: DocItem, nodesById: Map<string, CodeMapNode>): string {
  if (doc.source_node_ids.length === 0) return `<p class="muted">Tài liệu không gắn với hàm nào trong code_map.</p>`;
  const name = (id: string) => escapeHtml(nodesById.get(id)?.name ?? id);
  const rows = doc.source_node_ids
    .map((id) => {
      const n = nodesById.get(id);
      if (!n) return `<tr class="row-missing"><td><code>${escapeHtml(id)}</code></td><td colspan="3">Không có trong code_map</td></tr>`;
      return `<tr>
  <td><code>${escapeHtml(n.name)}</code><div class="sub">${escapeHtml(n.node_id)}</div></td>
  <td class="path">${escapeHtml(n.file_path)}</td>
  <td class="num">${n.start_line}–${n.end_line}</td>
  <td>${n.calls.length ? n.calls.map(name).join(", ") : `<span class="muted">—</span>`}</td>
</tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table class="data nodes">
  <thead><tr><th>Hàm / lớp</th><th>File</th><th class="num">Dòng</th><th>Gọi tới</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

function mermaidPanel(doc: DocItem): string {
  const diagrams: { label: string; code: string }[] = [];
  if (doc.mermaid_diagram && doc.mermaid_diagram.trim()) {
    diagrams.push({ label: "mermaid_diagram", code: stripFence(doc.mermaid_diagram) });
  }
  const fenceRe = /^ {0,3}(`{3,}|~{3,})\s*mermaid[^\n]*\n([\s\S]*?)\n {0,3}\1\s*$/gim;
  for (const m of doc.markdown.matchAll(fenceRe)) {
    diagrams.push({ label: "khối mermaid trong markdown", code: m[2] ?? "" });
  }
  if (diagrams.length === 0) return `<p class="muted">Tài liệu không có sơ đồ Mermaid.</p>`;
  return diagrams
    .map(
      (d) => `<h3 class="diagram-label">${escapeHtml(d.label)}</h3>
${diagramBlock(d.code)}
<details class="diagram-code"><summary>Mã Mermaid</summary><pre><code>${escapeHtml(d.code)}</code></pre></details>`
    )
    .join("\n");
}

/** Markdown: công tắc chuyển giữa bản đã render (Beautify) và mã gốc. */
function markdownPanel(doc: DocItem, pathToDocId: Map<string, string>): string {
  return `<div class="md-toolbar">
  <div class="segmented" role="group" aria-label="Chế độ xem Markdown">
    <button type="button" data-md-mode="pretty" class="active">Beautify</button>
    <button type="button" data-md-mode="raw">Gốc</button>
  </div>
</div>
<article class="markdown-body" data-md-view="pretty">${renderMarkdown(doc.markdown, doc.path, pathToDocId)}</article>
<pre class="raw" data-md-view="raw" hidden><code>${escapeHtml(doc.markdown)}</code></pre>`;
}

function metric(label: string, value: string, tone: "ok" | "warn" | "error" | "plain" = "plain", hint = ""): string {
  return `<div class="metric metric-${tone}"><div class="metric-value">${escapeHtml(value)}</div><div class="metric-label">${escapeHtml(label)}</div>${
    hint ? `<div class="metric-hint">${escapeHtml(hint)}</div>` : ""
  }</div>`;
}

function codeMapTable(codeMap: CodeMapNode[]): string {
  if (codeMap.length === 0) return `<p class="muted">code_map trống.</p>`;
  const nameOf = new Map(codeMap.map((n) => [n.node_id, n.name]));
  const rows = codeMap
    .map(
      (n) => `<tr>
  <td><code>${escapeHtml(n.name)}</code><div class="sub">${escapeHtml(n.node_id)}</div></td>
  <td class="path">${escapeHtml(n.file_path)}</td>
  <td class="num">${n.start_line}–${n.end_line}</td>
  <td>${
    n.calls.length
      ? n.calls
          .map((id) => (nameOf.has(id) ? `<code>${escapeHtml(nameOf.get(id)!)}</code>` : `<code class="bad" title="Không có trong code_map">${escapeHtml(id)}</code>`))
          .join(", ")
      : `<span class="muted">—</span>`
  }</td>
</tr>`
    )
    .join("\n");
  return `<div class="table-wrap"><table class="data nodes">
  <thead><tr><th>Hàm / lớp</th><th>File</th><th class="num">Dòng</th><th>calls</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

/** Tab Summary: mọi thứ result.json của job có, cộng số liệu kiểm tra & AI Harness. */
function summaryPanel(job: PreviewResult, jobReport: ValidationReport | undefined, currentDocId: string): string {
  const s = jobReport?.summary;
  const reports = new Map((jobReport?.documents ?? []).map((d) => [d.doc_id, d]));
  const files = new Set(job.code_map.map((n) => n.file_path)).size;

  const metrics = s
    ? `<div class="metrics">
  ${metric("Tỉ lệ bịa tên", `${s.hallucination_rate}%`, s.hallucinated_symbols ? "error" : "ok", `${s.hallucinated_symbols}/${s.referenced_symbols} tên được nhắc`)}
  ${metric("Sơ đồ hiển thị được", `${s.mermaid_ok}/${s.mermaid_total}`, s.mermaid_ok < s.mermaid_total ? "error" : "ok")}
  ${metric("Qua AI Harness", `${s.harness_passed}/${s.documents}`, s.harness_passed < s.documents ? "error" : "ok", "tài liệu")}
  ${metric("Lỗi", String(s.errors), s.errors ? "error" : "ok")}
  ${metric("Cảnh báo", String(s.warnings), s.warnings ? "warn" : "ok")}
</div>`
    : "";

  const docRows = job.documents
    .map((d) => {
      const r = reports.get(d.doc_id);
      const h = r?.harness;
      const current = d.doc_id === currentDocId ? ` class="row-current"` : "";
      const diagram = d.mermaid_diagram && d.mermaid_diagram.trim() ? (h?.mermaid.valid === false ? `<span class="bad">lỗi</span>` : "có") : `<span class="muted">—</span>`;
      return `<tr${current}>
  <td><a href="${escapeHtml(docFileName(d.doc_id))}">${escapeHtml(d.title || d.doc_id)}</a><div class="sub">${escapeHtml(d.doc_id)}</div></td>
  <td class="path">${escapeHtml(d.path)}</td>
  <td class="num">${d.source_node_ids.length}</td>
  <td>${diagram}</td>
  <td class="num">${h ? `${h.hallucinated_symbols.length}/${h.referenced_symbols}` : "—"}</td>
  <td>${h ? (h.passed ? `<span class="good">Đạt</span>` : `<span class="bad">Không đạt</span>`) : "—"}</td>
  <td>${statusBadge(r?.issues ?? [])}</td>
</tr>`;
    })
    .join("\n");

  return `<section class="summary">
  <dl class="job-info">
    <dt>job_id</dt><dd><code>${escapeHtml(job.job_id)}</code></dd>
    <dt>status</dt><dd>${escapeHtml(job.status)}</dd>
    <dt>commit_sha</dt><dd><code>${escapeHtml(job.commit_sha || "—")}</code></dd>
    <dt>documents</dt><dd>${job.documents.length}</dd>
    <dt>code_map</dt><dd>${job.code_map.length} node · ${files} file</dd>
  </dl>
  ${metrics}
  <h2>Tài liệu (${job.documents.length})</h2>
  ${
    job.documents.length
      ? `<div class="table-wrap"><table class="data">
  <thead><tr><th>Tài liệu</th><th>path</th><th class="num">source_node_ids</th><th>Sơ đồ</th><th class="num">Bịa tên</th><th>AI Harness</th><th>Kiểm tra</th></tr></thead>
  <tbody>${docRows}</tbody>
</table></div>`
      : `<p class="muted">Không có tài liệu.</p>`
  }
  <h2>Kiểm tra cấp job</h2>
  ${issuesPanel(jobReport?.global ?? [])}
  <h2>code_map (${job.code_map.length})</h2>
  ${codeMapTable(job.code_map)}
  <details class="raw-json"><summary>result.json gốc</summary><pre class="raw"><code>${escapeHtml(JSON.stringify(job, null, 2))}</code></pre></details>
</section>`;
}

async function readCss(): Promise<string> {
  return readFile(CSS_URL, "utf8");
}

function pageShell(title: string, css: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
${body}
${script}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Trang cho từng tài liệu
// ---------------------------------------------------------------------------

export interface DocPageInput {
  job: PreviewResult;
  doc: DocItem;
  report: DocumentReport | undefined;
  /** Báo cáo cả job (cho tab Summary). */
  jobReport?: ValidationReport;
}

export async function renderDocPage({ job, doc, report, jobReport }: DocPageInput): Promise<string> {
  const nodesById = new Map(job.code_map.map((n) => [n.node_id, n]));
  const pathToDocId = new Map(job.documents.map((d) => [d.path, d.doc_id]));
  const issues = report?.issues ?? [];

  const tabs = [
    { id: "markdown", label: "Markdown", html: markdownPanel(doc, pathToDocId) },
    { id: "mermaid", label: "Mermaid", html: mermaidPanel(doc) },
    { id: "source", label: `Mã nguồn (${doc.source_node_ids.length})`, html: sourcePanel(doc, nodesById) },
    { id: "issues", label: `Kiểm tra ${statusBadge(issues)}`, html: harnessCard(report?.harness) + issuesPanel(issues) },
    { id: "summary", label: "Summary", html: summaryPanel(job, jobReport, doc.doc_id) },
  ];

  const body = `<main class="doc">
  <header class="doc-head">
    <p class="crumb">${escapeHtml(job.job_id)}${job.commit_sha ? ` · ${escapeHtml(job.commit_sha.slice(0, 7))}` : ""} · ${escapeHtml(doc.path)}</p>
    <h1>${escapeHtml(doc.title || doc.doc_id)}</h1>
    ${docStats(report)}
  </header>
  <nav class="tabs" role="tablist">
    ${tabs.map((t, i) => `<button type="button" role="tab" data-tab="${t.id}"${i === 0 ? ' class="active"' : ""}>${t.label}</button>`).join("\n    ")}
  </nav>
  ${tabs.map((t, i) => `<section class="panel" data-panel="${t.id}"${i === 0 ? "" : " hidden"}>${t.html}</section>`).join("\n  ")}
</main>`;

  // Mermaid chỉ vẽ được khi phần tử đang hiển thị -> vẽ tab nào khi tab đó được mở.
  const script = `<script src="https://cdn.jsdelivr.net/npm/mermaid@${installedMermaidVersion()}/dist/mermaid.min.js"></script>
<script>
(function () {
  var dark = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
  function draw(panel) {
    if (!window.mermaid) return;
    var nodes = panel.querySelectorAll("pre.mermaid:not([data-processed])");
    if (nodes.length) mermaid.run({ nodes: nodes, suppressErrors: true });
  }
  var buttons = document.querySelectorAll("[data-tab]");
  function show(id) {
    buttons.forEach(function (b) { b.classList.toggle("active", b.dataset.tab === id); });
    document.querySelectorAll("[data-panel]").forEach(function (p) {
      p.hidden = p.dataset.panel !== id;
      if (!p.hidden) draw(p);
    });
  }
  buttons.forEach(function (b) {
    b.addEventListener("click", function () { show(b.dataset.tab); history.replaceState(null, "", "#" + b.dataset.tab); });
  });
  show(location.hash.slice(1) || "markdown");

  var modes = document.querySelectorAll("[data-md-mode]");
  modes.forEach(function (b) {
    b.addEventListener("click", function () {
      modes.forEach(function (m) { m.classList.toggle("active", m === b); });
      document.querySelectorAll("[data-md-view]").forEach(function (v) { v.hidden = v.dataset.mdView !== b.dataset.mdMode; });
    });
  });
})();
</script>`;

  return pageShell(`${doc.title || doc.doc_id} · Preview`, await readCss(), body, script);
}

// ---------------------------------------------------------------------------
// index.html: sidebar chứa mọi tài liệu, nội dung mở trong khung bên phải
// ---------------------------------------------------------------------------

export interface IndexEntry {
  job: PreviewResult;
  /** Thư mục con chứa các file preview của job (tương đối với index.html). */
  dir: string;
  reports: Map<string, DocumentReport>;
}

export async function renderIndexPage(entries: IndexEntry[]): Promise<string> {
  // Mỗi job là một mục: tên mục là job_id (job có nhiều tài liệu thì mỗi tài liệu một mục, cùng tên job).
  const groups = entries
    .map(({ job, dir, reports }) => {
      const commit = job.commit_sha ? ` · ${job.commit_sha.slice(0, 7)}` : "";
      const links = job.documents
        .map((doc) => {
          const href = `${dir}/${docFileName(doc.doc_id)}`;
          return `<a class="nav-item" href="${escapeHtml(href)}" target="viewer" title="${escapeHtml(doc.title || doc.doc_id)}">
  <span class="nav-text"><span class="nav-title">${escapeHtml(job.job_id)}</span><span class="nav-sub">${escapeHtml(doc.path + commit)}</span></span>
  ${statusBadge(reports.get(doc.doc_id)?.issues ?? [])}
</a>`;
        })
        .join("\n");
      return links || `<p class="muted pad">${escapeHtml(job.job_id)}: không có tài liệu.</p>`;
    })
    .join("\n");

  const first = entries.find((e) => e.job.documents.length > 0);
  const firstHref = first ? `${first.dir}/${docFileName(first.job.documents[0]!.doc_id)}` : "about:blank";

  const body = `<div class="app">
  <aside class="sidebar">
    <div class="brand">Docs Preview</div>
    ${groups || `<p class="muted pad">Không tìm thấy job nào.</p>`}
  </aside>
  <iframe class="viewer" name="viewer" title="Nội dung tài liệu" src="${escapeHtml(firstHref)}"></iframe>
</div>`;

  const script = `<script>
(function () {
  var links = document.querySelectorAll(".nav-item");
  function mark(a) { links.forEach(function (l) { l.classList.toggle("active", l === a); }); }
  links.forEach(function (a) { a.addEventListener("click", function () { mark(a); }); });
  if (links[0]) mark(links[0]);
})();
</script>`;

  return pageShell("Docs Preview", await readCss(), body, script);
}
