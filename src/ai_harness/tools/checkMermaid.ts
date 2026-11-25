import zlib from "node:zlib";
import type { MermaidCheckResult } from "../harnessTypes.js";

const VALID_HEADERS = [
  /^sequenceDiagram\b/,
  /^flowchart\s+(TD|TB|BT|RL|LR)\b/,
  /^graph\s+(TD|TB|BT|RL|LR)\b/,
  /^classDiagram\b/,
  /^stateDiagram(-v2)?\b/,
  /^erDiagram\b/,
];

export function createMermaidLiveUrl(mermaidCode: string): string {
  const cleanCode = stripMarkdownFence(mermaidCode).trim();
  const payload = JSON.stringify({
    code: cleanCode,
    mermaid: JSON.stringify({ theme: "default" }),
    autoSync: true,
    updateDiagram: true,
    updateEditor: true,
  });
  const compressed = zlib.deflateSync(Buffer.from(payload, "utf-8"), { level: 9 });
  const base64Url = compressed
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `https://mermaid.live/edit#pako:${base64Url}`;
}

export function stripMarkdownFence(code: string): string {
  return code
    .replace(/\u00A0/g, " ")
    .trim()
    .replace(/^```(?:mermaid)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .trim();
}

export function kiem_tra_cu_phap_so_do(mermaidCode: string | null | undefined): MermaidCheckResult {
  const errors: string[] = [];
  const rawTrimmed = (mermaidCode ?? "").trim();
  const liveUrl = createMermaidLiveUrl(rawTrimmed || 'flowchart TD\n  Empty["Trống"]');

  if (!rawTrimmed) {
    return {
      valid: false,
      errors: ["Mã sơ đồ Mermaid đang để trống."],
      mermaidLiveUrl: liveUrl,
    };
  }

  if (/^```/m.test(rawTrimmed)) {
    errors.push(
      "Mã Mermaid không được chứa dấu rào Markdown ```mermaid ... ``` bên trong chuỗi dữ liệu."
    );
  }

  const cleaned = stripMarkdownFence(rawTrimmed);
  const rawLines = cleaned.split(/\r?\n/);
  const nonEmptyLines = rawLines
    .map((text, idx) => ({ text: text.trim(), lineNo: idx + 1 }))
    .filter((item) => item.text.length > 0 && !item.text.startsWith("%%"));

  const firstLine = nonEmptyLines[0];
  if (!firstLine) {
    return {
      valid: false,
      errors: ["Sơ đồ không có nội dung hợp lệ."],
      mermaidLiveUrl: liveUrl,
    };
  }

  const headerLine = firstLine.text;
  const matchedHeader = VALID_HEADERS.find((rx) => rx.test(headerLine));
  if (!matchedHeader) {
    errors.push(
      `Dòng ${firstLine.lineNo}: Khai báo loại sơ đồ không hợp lệ ("${headerLine}"). Phải bắt đầu bằng "sequenceDiagram" hoặc "flowchart TD" / "flowchart LR".`
    );
    return {
      valid: false,
      errors,
      mermaidLiveUrl: liveUrl,
    };
  }

  const diagramType = headerLine.split(/\s+/)[0] ?? "flowchart";

  if (nonEmptyLines.length < 2) {
    errors.push("Sơ đồ chỉ có dòng tiêu đề, chưa có bất kỳ nút hoặc luồng kết nối nào.");
  }

  if (diagramType === "flowchart" || diagramType === "graph") {
    validateFlowchartLines(nonEmptyLines.slice(1), errors);
  } else if (diagramType === "sequenceDiagram") {
    validateSequenceLines(nonEmptyLines.slice(1), errors);
  } else {
    validateGenericQuotes(nonEmptyLines.slice(1), errors);
  }

  return {
    valid: errors.length === 0,
    diagramType,
    errors,
    mermaidLiveUrl: liveUrl,
  };
}

function validateFlowchartLines(
  lines: Array<{ text: string; lineNo: number }>,
  errors: string[]
): void {
  let subgraphDepth = 0;

  for (const { text, lineNo } of lines) {
    const quoteCount = (text.match(/"/g) ?? []).length;
    if (quoteCount % 2 !== 0) {
      errors.push(`Dòng ${lineNo}: Thiếu dấu đóng ngoặc kép (") trong câu lệnh "${text}".`);
      continue;
    }

    if (/^subgraph\b/.test(text)) {
      subgraphDepth += 1;
      const subLabel = text.replace(/^subgraph\s+/, "");
      if (/[()]/.test(subLabel) && !subLabel.includes('"')) {
        errors.push(
          `Dòng ${lineNo}: Tiêu đề subgraph chứa dấu ngoặc tròn () nhưng chưa bọc trong ngoặc kép "..." ("${text}").`
        );
      }
      continue;
    }

    if (text === "end") {
      if (subgraphDepth === 0) {
        errors.push(`Dòng ${lineNo}: Từ khóa "end" dư thừa (không có subgraph mở tương ứng).`);
      } else {
        subgraphDepth -= 1;
      }
      continue;
    }

    if (/^(style|classDef|class|click|linkStyle|direction)\b/.test(text)) {
      continue;
    }

    const strippedQuotes = text.replace(/"[^"]*"/g, '""');
    if (/--+>\s*[A-Za-z0-9_]+\s*:\s*\S+/.test(strippedQuotes)) {
      errors.push(
        `Dòng ${lineNo}: Flowchart không hỗ trợ cú pháp "A --> B: nhãn". Hãy đổi thành 'A -->|"nhãn"| B'.`
      );
    }

    if (/--\s+[^"\r\n]*[()][^"\r\n]*--+>/.test(strippedQuotes)) {
      errors.push(
        `Dòng ${lineNo}: Nhãn trên mũi tên "-- ... -->" chứa dấu ngoặc tròn () nhưng chưa bọc trong dấu ngoặc kép (ví dụ đúng: A -- "Sai (Not OK)" --> B).`
      );
    }

    if (/->>|-->>/.test(strippedQuotes)) {
      errors.push(
        `Dòng ${lineNo}: Mũi tên "->>" là của sequenceDiagram, trong flowchart phải dùng "-->" hoặc "-.->".`
      );
    }

    const squareBracketMatches = text.matchAll(/\[([^\]]*)\]/g);
    for (const match of squareBracketMatches) {
      const inner = (match[1] ?? "").trim();
      if (inner.startsWith('"') && inner.endsWith('"')) continue;
      if (/[(){}[\]]/.test(inner)) {
        errors.push(
          `Dòng ${lineNo}: Nhãn [${inner}] chứa ký tự đặc biệt ()/{} nhưng không bọc trong dấu ngoặc kép. Hãy sửa thành ["${inner.replace(/"/g, "'")}"].`
        );
      }
    }

    if (!areBracketsBalanced(strippedQuotes)) {
      errors.push(
        `Dòng ${lineNo}: Cặp dấu ngoặc [], () hoặc {} bị lệch/chưa đóng hết trong "${text}".`
      );
    }
  }

  if (subgraphDepth > 0) {
    errors.push(`Thiếu ${subgraphDepth} từ khóa "end" để đóng khối subgraph.`);
  }
}

function validateSequenceLines(
  lines: Array<{ text: string; lineNo: number }>,
  errors: string[]
): void {
  let blockDepth = 0;
  const blockOpeners = /^(loop|alt|opt|par|critical|rect|box)\b/;
  const validDirectives =
    /^(participant|actor|activate|deactivate|Note|else|and|option|break|autonumber|title)\b/i;
  const messageArrow =
    /^[A-Za-z0-9_."-]+\s*(?:->>|-->>|->|-->|-x|--x|-\)|--\)|<<->>|<<-->>)\+?-?\s*[A-Za-z0-9_."-]+\s*:\s*.+$/;
  const missingColonArrow =
    /^[A-Za-z0-9_."-]+\s*(?:->>|-->>|->|-->|-x|--x)\s*[A-Za-z0-9_."-]+\s*$/;

  for (const { text, lineNo } of lines) {
    const quoteCount = (text.match(/"/g) ?? []).length;
    if (quoteCount % 2 !== 0) {
      errors.push(`Dòng ${lineNo}: Thiếu dấu đóng ngoặc kép (") trong "${text}".`);
      continue;
    }

    if (blockOpeners.test(text)) {
      blockDepth += 1;
      continue;
    }

    if (text === "end") {
      if (blockDepth === 0) {
        errors.push(`Dòng ${lineNo}: Từ khóa "end" dư thừa trong sequenceDiagram.`);
      } else {
        blockDepth -= 1;
      }
      continue;
    }

    if (validDirectives.test(text)) {
      if (/^(participant|actor)\b/.test(text) && /[()]/.test(text) && !text.includes('"')) {
        errors.push(
          `Dòng ${lineNo}: Khai báo participant chứa dấu () nhưng chưa bọc ngoặc kép: "${text}".`
        );
      }
      continue;
    }

    if (missingColonArrow.test(text)) {
      errors.push(
        `Dòng ${lineNo}: Thông điệp trong sequenceDiagram thiếu dấu hai chấm và nội dung mô tả (ví dụ đúng: "A->>B: Gọi hàm").`
      );
      continue;
    }

    if (!messageArrow.test(text)) {
      errors.push(`Dòng ${lineNo}: Cú pháp câu lệnh sequenceDiagram không hợp lệ: "${text}".`);
    }
  }

  if (blockDepth > 0) {
    errors.push(`Thiếu ${blockDepth} từ khóa "end" để đóng khối loop/alt/opt trong sequenceDiagram.`);
  }
}

function validateGenericQuotes(
  lines: Array<{ text: string; lineNo: number }>,
  errors: string[]
): void {
  for (const { text, lineNo } of lines) {
    const quoteCount = (text.match(/"/g) ?? []).length;
    if (quoteCount % 2 !== 0) {
      errors.push(`Dòng ${lineNo}: Thiếu dấu đóng ngoặc kép (") trong "${text}".`);
    }
  }
}

function areBracketsBalanced(input: string): boolean {
  const sanitized = input.replace(/<--+|--+>|\.-+>|==+>/g, " ");
  const stack: string[] = [];
  const pairs: Record<string, string> = { "]": "[", ")": "(", "}": "{" };

  for (const ch of sanitized) {
    if (ch === "[" || ch === "(" || ch === "{") {
      stack.push(ch);
    } else if (ch === "]" || ch === ")" || ch === "}") {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}
