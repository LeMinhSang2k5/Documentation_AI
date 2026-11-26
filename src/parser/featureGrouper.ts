import path from "node:path";
import type { CodeMapNode, ParsedFile } from "../types/index.js";

/**
 * Các hậu tố vai trò kiến trúc phổ quát (không phụ thuộc 1 framework cụ thể)
 * để rút ra tên miền nghiệp vụ (domain stem) từ tên file:
 * VD: AuthController.java, AuthService.java, AuthRequest.java, authService.js -> "auth"
 *     QuitPlanController.java, QuitPlanService.java, QuitPlanDAO.java -> "quit_plan"
 */
const ROLE_SUFFIX_WORDS = new Set([
  "controller",
  "controllers",
  "service",
  "services",
  "repository",
  "repositories",
  "reponsitory",
  "reponsitories",
  "dao",
  "model",
  "models",
  "entity",
  "entities",
  "dto",
  "dtos",
  "request",
  "requests",
  "response",
  "responses",
  "route",
  "routes",
  "router",
  "routers",
  "handler",
  "handlers",
  "page",
  "pages",
  "view",
  "views",
  "component",
  "components",
  "context",
  "hook",
  "hooks",
  "store",
  "slice",
  "reducer",
  "provider",
  "manager",
  "helper",
  "helpers",
  "util",
  "utils",
  "client",
  "api",
  "config",
  "filter",
  "guard",
  "middleware",
  "schema",
  "schemas",
  "exception",
  "exceptions",
  "scheduler",
  "modal",
  "widget",
  "section",
  "form",
  "card",
  "list",
  "detail",
  "item",
  "data",
  "types",
  "type",
  "interface",
  "migration",
]);

const GENERIC_NON_DOMAIN_STEMS = new Set([
  "",
  "index",
  "main",
  "app",
  "root",
  "common",
  "shared",
  "base",
  "core",
  "default",
  "global",
  "custom",
  "application",
  "server",
  "client",
  "api",
  "web",
  "http",
]);

function splitIdentifierWords(baseName: string): string[] {
  return baseName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function singularizeWord(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies") && word.length > 4) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("ches") || word.endsWith("shes")) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Rút ra domain stem nghiệp vụ từ tên file (VD: `useTasks.js` -> `task`, `AuthController.java` -> `auth`).
 * Trả về `null` nếu file mang tên chung chung (vd `index.ts`, `App.jsx`, `client.js`).
 */
export function extractDomainStem(filePath: string): string | null {
  const baseName = path.posix.basename(filePath, path.posix.extname(filePath));
  const words = splitIdentifierWords(baseName);
  if (words.length === 0) return null;

  // Bỏ tiền tố React hook `use` (vd `useTasks` -> `tasks`, `useAuth` -> `auth`)
  let start = 0;
  if (words[0] === "use" && words.length > 1) {
    start = 1;
  }

  // Bỏ các hậu tố vai trò kiến trúc ở cuối (vd `QuitPlanController` -> `quit_plan`, `AuthRequestDto` -> `auth`)
  let end = words.length;
  while (end > start && ROLE_SUFFIX_WORDS.has(words[end - 1]!)) {
    end -= 1;
  }

  // Bỏ thêm chữ số ở cuối nếu có (vd `LayLaiMatKhau1`, `LayLaiMatKhau2` -> `lay_lai_mat_khau`)
  while (end > start && /^\d+$/.test(words[end - 1]!)) {
    end -= 1;
  }

  const stemWords = words.slice(start, end).map(singularizeWord);
  if (stemWords.length === 0) return null;

  const stem = stemWords.join("_");
  if (GENERIC_NON_DOMAIN_STEMS.has(stem) || stem.length < 3) {
    return null;
  }

  return stem;
}

function toFeatureTitle(stem: string): string {
  return stem
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

/**
 * Gom file theo **Chức năng nghiệp vụ (Feature Module)** kết hợp 2 tín hiệu không hardcode framework:
 * 1. Domain stem chung giữa các tầng (Controller + Service + Repository + Model + Frontend Page/Hook/Context).
 * 2. Đồ thị gọi hàm (`code_map.calls`): file lẻ chưa có cụm sẽ tự gắn vào Feature Module mà nó gọi / được gọi nhiều nhất.
 * 3. Các file hạ tầng độc lập còn lại rơi về thư mục gốc qua `fallbackFolderKey`.
 */
export function groupFilesByBusinessFeature(
  parsedFiles: ParsedFile[],
  codeMap: CodeMapNode[],
  fallbackFolderKey: (filePath: string) => string
): Map<string, ParsedFile[]> {
  // Bước 1: Nhóm sơ bộ theo domain stem
  const stemToFiles = new Map<string, ParsedFile[]>();
  const fileToStem = new Map<string, string | null>();

  for (const file of parsedFiles) {
    const stem = extractDomainStem(file.file_path);
    fileToStem.set(file.file_path, stem);
    if (stem) {
      const list = stemToFiles.get(stem) ?? [];
      list.push(file);
      stemToFiles.set(stem, list);
    }
  }

  // Chỉ công nhận Feature Cluster khi có >= 2 file cùng domain (ví dụ AuthController + AuthService)
  const confirmedFeatureByFile = new Map<string, string>();
  for (const [stem, files] of stemToFiles.entries()) {
    if (files.length >= 2) {
      const featureLabel = `Feature: ${toFeatureTitle(stem)}`;
      for (const f of files) {
        confirmedFeatureByFile.set(f.file_path, featureLabel);
      }
    }
  }

  // Bước 2: Xây đồ thị file-to-file từ `code_map.calls` để gắn các file liên quan vào đúng Feature
  const nodeIdToFile = new Map<string, string>();
  for (const node of codeMap) {
    nodeIdToFile.set(node.node_id, node.file_path);
  }

  const fileNeighbors = new Map<string, Map<string, number>>();
  const addEdge = (a: string, b: string): void => {
    if (a === b) return;
    const mapA = fileNeighbors.get(a) ?? new Map<string, number>();
    mapA.set(b, (mapA.get(b) ?? 0) + 1);
    fileNeighbors.set(a, mapA);
  };

  for (const node of codeMap) {
    for (const targetId of node.calls) {
      const targetFile = nodeIdToFile.get(targetId);
      if (targetFile && targetFile !== node.file_path) {
        addEdge(node.file_path, targetFile);
        addEdge(targetFile, node.file_path);
      }
    }
  }

  // Gắn file chưa có Feature vào Feature mà nó liên kết gọi hàm mạnh nhất (nếu có)
  const buckets = new Map<string, ParsedFile[]>();
  for (const file of parsedFiles) {
    let assignedKey = confirmedFeatureByFile.get(file.file_path);

    if (!assignedKey) {
      const neighbors = fileNeighbors.get(file.file_path);
      if (neighbors) {
        const featureWeights = new Map<string, number>();
        for (const [neighborFile, weight] of neighbors.entries()) {
          const neighborFeature = confirmedFeatureByFile.get(neighborFile);
          if (neighborFeature) {
            featureWeights.set(
              neighborFeature,
              (featureWeights.get(neighborFeature) ?? 0) + weight
            );
          }
        }
        let bestFeature: string | null = null;
        let bestWeight = 0;
        for (const [feat, w] of featureWeights.entries()) {
          if (w > bestWeight) {
            bestWeight = w;
            bestFeature = feat;
          }
        }
        if (bestFeature && bestWeight >= 1) {
          assignedKey = bestFeature;
        }
      }
    }

    if (!assignedKey) {
      assignedKey = fallbackFolderKey(file.file_path);
    }

    const list = buckets.get(assignedKey) ?? [];
    list.push(file);
    buckets.set(assignedKey, list);
  }

  return buckets;
}
