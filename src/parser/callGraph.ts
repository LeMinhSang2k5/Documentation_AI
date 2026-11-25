import path from "node:path";
import type { CodeMapNode, ParsedFile, ParsedFunction } from "../types/index.js";

const RESOLVABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function toSlug(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function createNodeId(filePath: string, fnName: string, usedIds: Set<string>): string {
  const withoutExt = filePath.replace(/\.[^/.]+$/, "");
  const filePart = toSlug(withoutExt);
  const fnPart = toSlug(fnName);
  const baseId = `fn_${filePart}_${fnPart}`;

  if (!usedIds.has(baseId)) {
    usedIds.add(baseId);
    return baseId;
  }

  let suffix = 2;
  while (usedIds.has(`${baseId}_${suffix}`)) {
    suffix += 1;
  }
  const uniqueId = `${baseId}_${suffix}`;
  usedIds.add(uniqueId);
  return uniqueId;
}

function resolveImportTargetFile(
  fromFilePath: string,
  importSource: string,
  allFilePaths: Set<string>
): string | null {
  if (!importSource.startsWith(".")) {
    return null;
  }

  const fromDir = path.posix.dirname(fromFilePath);
  const rawTarget = path.posix.normalize(path.posix.join(fromDir, importSource));

  // Direct match (e.g., "./auth.js" in JS repo)
  if (allFilePaths.has(rawTarget)) {
    return rawTarget;
  }

  // Strip .js/.jsx/.mjs/.cjs extension for TS ESM imports (`./jobQueue.js` -> `./jobQueue.ts`)
  const stripped = rawTarget.replace(/\.(?:[cm]?js|jsx)$/i, "");
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = `${stripped}${ext}`;
    if (allFilePaths.has(candidate)) {
      return candidate;
    }
  }

  // Directory index import (`./utils` -> `./utils/index.ts`)
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const indexCandidate = `${rawTarget}/index${ext}`;
    if (allFilePaths.has(indexCandidate)) {
      return indexCandidate;
    }
  }

  return null;
}

interface IndexedFunction {
  nodeId: string;
  filePath: string;
  fn: ParsedFunction;
}

export function buildCodeMap(parsedFiles: ParsedFile[]): CodeMapNode[] {
  const usedIds = new Set<string>();
  const allFilePaths = new Set(parsedFiles.map((file) => file.file_path));

  const indexedAll: IndexedFunction[] = [];
  const byFile = new Map<string, IndexedFunction[]>();
  const bySimpleName = new Map<string, IndexedFunction[]>();

  for (const file of parsedFiles) {
    const fileItems: IndexedFunction[] = [];

    for (const fn of file.functions) {
      const nodeId = createNodeId(file.file_path, fn.name, usedIds);
      const item: IndexedFunction = {
        nodeId,
        filePath: file.file_path,
        fn,
      };
      indexedAll.push(item);
      fileItems.push(item);

      const simpleName = fn.name.includes(".")
        ? fn.name.slice(fn.name.lastIndexOf(".") + 1)
        : fn.name;

      const list = bySimpleName.get(simpleName) ?? [];
      list.push(item);
      bySimpleName.set(simpleName, list);
    }

    byFile.set(file.file_path, fileItems);
  }

  const fileMap = new Map(parsedFiles.map((file) => [file.file_path, file]));

  function resolveSingleCall(
    caller: IndexedFunction,
    rawCall: string
  ): string | null {
    const sameFileItems = byFile.get(caller.filePath) ?? [];
    const currentFile = fileMap.get(caller.filePath);

    // 1. Same-class method call: `this.methodName`
    if (rawCall.startsWith("this.") && caller.fn.class_name) {
      const methodName = rawCall.slice("this.".length).split(".")[0];
      if (methodName) {
        const expected = `${caller.fn.class_name}.${methodName}`;
        const hit = sameFileItems.find((item) => item.fn.name === expected);
        if (hit && hit.nodeId !== caller.nodeId) {
          return hit.nodeId;
        }
      }
    }

    // 2. Direct function or constructor call in same file
    const normalizedCall = rawCall.startsWith("new ")
      ? rawCall.slice("new ".length)
      : rawCall;

    const sameFileHit = sameFileItems.find(
      (item) =>
        item.fn.name === normalizedCall ||
        item.fn.class_name === normalizedCall
    );
    if (sameFileHit && sameFileHit.nodeId !== caller.nodeId) {
      return sameFileHit.nodeId;
    }

    // 3. Cross-file resolution via relative imports
    if (currentFile) {
      const callParts = normalizedCall.split(".");
      const rootIdentifier = callParts[0];
      const memberName = callParts[1];

      for (const imp of currentFile.imports) {
        const targetFile = resolveImportTargetFile(
          caller.filePath,
          imp.source,
          allFilePaths
        );
        if (!targetFile) continue;

        const targetItems = byFile.get(targetFile) ?? [];
        if (targetItems.length === 0) continue;

        // Named import match: `import { foo } from "./bar"` -> `foo()` or `ClassName.method()`
        if (rootIdentifier && imp.imported_names.includes(rootIdentifier)) {
          if (memberName) {
            const classMethodHit = targetItems.find(
              (item) => item.fn.name === `${rootIdentifier}.${memberName}`
            );
            if (classMethodHit) return classMethodHit.nodeId;
          }
          const directHit = targetItems.find(
            (item) =>
              item.fn.name === rootIdentifier ||
              (item.fn.class_name === rootIdentifier &&
                item.fn.name.endsWith(".constructor"))
          );
          if (directHit) return directHit.nodeId;
        }

        // Default or namespace import match: `import api from "./client"` -> `api.getTasks()` or `api()`
        if (
          rootIdentifier &&
          (imp.default_import === rootIdentifier ||
            imp.namespace_import === rootIdentifier)
        ) {
          if (memberName) {
            const memberHit = targetItems.find(
              (item) =>
                item.fn.name === memberName ||
                item.fn.name.endsWith(`.${memberName}`)
            );
            if (memberHit) return memberHit.nodeId;
          } else {
            const defaultHit =
              targetItems.find((item) => item.fn.name === "default") ??
              targetItems.find((item) => item.fn.is_exported) ??
              targetItems[0];
            if (defaultHit) return defaultHit.nodeId;
          }
        }
      }
    }

    // 4. Member call on injected instance like `this.jobStore.update` or `jobQueue.enqueue`
    if (normalizedCall.includes(".")) {
      const methodPart = normalizedCall.split(".").at(-1);
      if (methodPart && methodPart !== "constructor") {
        const candidates = bySimpleName.get(methodPart);
        if (candidates && candidates.length === 1) {
          const only = candidates[0];
          if (only && only.nodeId !== caller.nodeId) {
            return only.nodeId;
          }
        }
      }
    } else {
      // Unique top-level function name fallback
      const candidates = bySimpleName.get(normalizedCall);
      if (candidates && candidates.length === 1) {
        const only = candidates[0];
        if (only && only.nodeId !== caller.nodeId) {
          return only.nodeId;
        }
      }
    }

    return null;
  }

  return indexedAll.map((item) => {
    const resolvedCalls = new Set<string>();
    for (const rawCall of item.fn.raw_calls) {
      const targetNodeId = resolveSingleCall(item, rawCall);
      if (targetNodeId) {
        resolvedCalls.add(targetNodeId);
      }
    }

    return {
      node_id: item.nodeId,
      name: item.fn.name,
      file_path: item.filePath,
      start_line: item.fn.start_line,
      end_line: item.fn.end_line,
      calls: Array.from(resolvedCalls),
    };
  });
}
