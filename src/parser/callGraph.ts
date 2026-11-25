import type { CodeMapNode, ParsedFile, ParsedFunction } from "../types/index.js";
import { getAdapterForFile } from "./languages/registry.js";

/**
 * Common standard-library / built-in method names across JS/TS, Python, C#, Java, Go.
 * Excluded from loose single-name fallback to prevent false-positive edges
 * (e.g. `map.get(k)` being falsely linked to `SupabaseJobStore.get`).
 */
const COMMON_BUILTIN_METHODS = new Set([
  "get",
  "set",
  "has",
  "delete",
  "add",
  "remove",
  "clear",
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "some",
  "every",
  "push",
  "pop",
  "shift",
  "unshift",
  "slice",
  "splice",
  "split",
  "join",
  "trim",
  "replace",
  "match",
  "test",
  "exec",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "toLowerCase",
  "toUpperCase",
  "toString",
  "valueOf",
  "keys",
  "values",
  "entries",
  "sort",
  "reverse",
  "concat",
  "flat",
  "flatMap",
  "then",
  "catch",
  "finally",
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "parse",
  "stringify",
  "resolve",
  "reject",
  "all",
  "race",
  "assign",
  "freeze",
  "from",
  "isArray",
  "now",
  "append",
  "extend",
  "items",
  "format",
  "strip",
  "lower",
  "upper",
  "read",
  "write",
  "close",
  "open",
  "send",
  "status",
  "json",
  "end",
  "next",
  "use",
  "listen",
  "on",
  "emit",
  "off",
  "once",
  "ToString",
  "Equals",
  "GetHashCode",
  "Add",
  "Remove",
  "Contains",
  "Count",
  "ToList",
  "FirstOrDefault",
  "Select",
  "Where",
]);

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

interface IndexedFunction {
  nodeId: string;
  filePath: string;
  fn: ParsedFunction;
}

export interface BuildCodeMapOptions {
  pathAliases?: Record<string, string[]>;
}

export function buildCodeMap(
  parsedFiles: ParsedFile[],
  options: BuildCodeMapOptions = {}
): CodeMapNode[] {
  const usedIds = new Set<string>();
  const allFilePaths = new Set(parsedFiles.map((file) => file.file_path));

  const indexedAll: IndexedFunction[] = [];
  const byFile = new Map<string, IndexedFunction[]>();
  const bySimpleName = new Map<string, IndexedFunction[]>();
  const byClassAndMethod = new Map<string, IndexedFunction[]>();

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

      if (fn.class_name) {
        const key = `${fn.class_name}.${simpleName}`;
        const classList = byClassAndMethod.get(key) ?? [];
        classList.push(item);
        byClassAndMethod.set(key, classList);
      }
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

    // 1. Same-class method call: `this.methodName` (also normalized from Python `self.methodName`)
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

    // 2. Direct function, nested function, or constructor call in same file
    const normalizedCall = rawCall.startsWith("new ")
      ? rawCall.slice("new ".length)
      : rawCall;

    const sameFileHit = sameFileItems.find(
      (item) =>
        item.fn.name === normalizedCall ||
        item.fn.class_name === normalizedCall ||
        item.fn.name === `${caller.fn.name}.${normalizedCall}`
    );
    if (sameFileHit && sameFileHit.nodeId !== caller.nodeId) {
      return sameFileHit.nodeId;
    }

    // 3. Cross-file resolution via language adapter import resolution
    if (currentFile) {
      const callParts = normalizedCall.split(".");
      const rootIdentifier = callParts[0];
      const memberName = callParts[1];
      let adapter: ReturnType<typeof getAdapterForFile> | null = null;
      try {
        adapter = getAdapterForFile(caller.filePath);
      } catch {
        adapter = null;
      }

      for (const imp of currentFile.imports) {
        const targetFile = adapter?.resolveImportTarget?.({
          fromFilePath: caller.filePath,
          importSource: imp.source,
          allFilePaths,
          pathAliases: options.pathAliases,
        });
        if (!targetFile) continue;

        const targetItems = byFile.get(targetFile) ?? [];
        if (targetItems.length === 0) continue;

        // Named import match (with alias support): `import { foo as bar } from "./x"` -> `bar()`
        if (rootIdentifier && imp.imported_names.includes(rootIdentifier)) {
          const originalName = imp.aliases?.[rootIdentifier] ?? rootIdentifier;
          if (memberName) {
            const classMethodHit = targetItems.find(
              (item) => item.fn.name === `${originalName}.${memberName}`
            );
            if (classMethodHit) return classMethodHit.nodeId;
          }
          const directHit = targetItems.find(
            (item) =>
              item.fn.name === originalName ||
              (item.fn.class_name === originalName &&
                item.fn.name.endsWith(".constructor")) ||
              (item.fn.class_name === originalName &&
                item.fn.name.endsWith(".__init__"))
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

    // 4. Exact ClassName.MethodName match (useful for C# / Java / static calls)
    const exactClassHits = byClassAndMethod.get(normalizedCall);
    if (exactClassHits && exactClassHits.length === 1) {
      const only = exactClassHits[0];
      if (only && only.nodeId !== caller.nodeId) {
        return only.nodeId;
      }
    }

    // 5. Safe member/function fallback (skipping common built-in method names to prevent false positives)
    if (normalizedCall.includes(".")) {
      const methodPart = normalizedCall.split(".").at(-1);
      if (
        methodPart &&
        methodPart !== "constructor" &&
        methodPart !== "__init__" &&
        !COMMON_BUILTIN_METHODS.has(methodPart)
      ) {
        const candidates = bySimpleName.get(methodPart);
        if (candidates && candidates.length === 1) {
          const only = candidates[0];
          if (only && only.nodeId !== caller.nodeId) {
            return only.nodeId;
          }
        }
      }
    } else if (!COMMON_BUILTIN_METHODS.has(normalizedCall)) {
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
