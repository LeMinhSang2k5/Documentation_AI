import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ParsedFunction, ParsedImport } from "../../types/index.js";
import type { ExtractedAstData, ImportResolveContext, LanguageAdapter } from "./types.js";

function extractPythonParams(fnNode: Node): string[] {
  const paramsNode = fnNode.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params: string[] = [];
  for (const child of paramsNode.namedChildren) {
    if (!child) continue;
    switch (child.type) {
      case "identifier":
        params.push(child.text);
        break;
      case "typed_parameter": {
        const id = child.namedChildren.find((c): c is Node => c !== null && c.type === "identifier");
        if (id) params.push(id.text);
        break;
      }
      case "default_parameter":
      case "typed_default_parameter": {
        const nameNode = child.childForFieldName("name");
        if (nameNode) params.push(nameNode.text);
        break;
      }
      case "list_splat_pattern":
      case "dictionary_splat_pattern":
        params.push(child.text);
        break;
      default:
        break;
    }
  }
  return params;
}

function formatPythonCallee(node: Node | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
      return node.text;
    case "attribute": {
      const obj = node.childForFieldName("object");
      const attr = node.childForFieldName("attribute");
      if (!attr) return null;
      const objName = formatPythonCallee(obj);
      return objName ? `${objName}.${attr.text}` : attr.text;
    }
    case "call":
      return formatPythonCallee(node.childForFieldName("function"));
    default:
      return null;
  }
}

function extractPythonCalls(bodyNode: Node | null): string[] {
  if (!bodyNode) return [];
  const calls = new Set<string>();
  const stack: Node[] = [bodyNode];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (current !== bodyNode && current.type === "function_definition") {
      continue;
    }

    if (current.type === "call") {
      const callee = formatPythonCallee(current.childForFieldName("function"));
      if (callee) {
        // Normalize `self.method` -> `this.method` so callGraph same-class resolution works uniformly
        calls.add(callee.startsWith("self.") ? `this.${callee.slice(5)}` : callee);
      }
    }

    const children = current.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }

  return Array.from(calls);
}

function extractPythonImport(stmt: Node, imports: ParsedImport[]): void {
  if (stmt.type === "import_statement") {
    for (const child of stmt.namedChildren) {
      if (!child) continue;
      if (child.type === "dotted_name") {
        imports.push({
          source: child.text,
          imported_names: [],
          namespace_import: child.text.split(".")[0],
        });
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        const aliasNode = child.childForFieldName("alias");
        if (nameNode) {
          imports.push({
            source: nameNode.text,
            imported_names: [],
            namespace_import: aliasNode?.text ?? nameNode.text.split(".")[0],
          });
        }
      }
    }
    return;
  }

  if (stmt.type === "import_from_statement") {
    const moduleNameNode = stmt.childForFieldName("module_name");
    const source = moduleNameNode?.text ?? "";
    const importedNames: string[] = [];
    const aliases: Record<string, string> = {};

    for (const child of stmt.namedChildren) {
      if (!child || child === moduleNameNode) continue;
      if (child.type === "dotted_name") {
        importedNames.push(child.text);
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        const aliasNode = child.childForFieldName("alias");
        if (nameNode) {
          const localName = aliasNode?.text ?? nameNode.text;
          importedNames.push(localName);
          if (aliasNode && aliasNode.text !== nameNode.text) {
            aliases[aliasNode.text] = nameNode.text;
          }
        }
      }
    }

    if (source) {
      const parsed: ParsedImport = { source, imported_names: importedNames };
      if (Object.keys(aliases).length > 0) {
        parsed.aliases = aliases;
      }
      imports.push(parsed);
    }
  }
}

function extractPythonFunction(
  fnNode: Node,
  functions: ParsedFunction[],
  className?: string,
  outerStartLine?: number
): void {
  const nameNode = fnNode.childForFieldName("name");
  if (!nameNode) return;

  const rawName = nameNode.text;
  const fullName = className ? `${className}.${rawName}` : rawName;
  const bodyNode = fnNode.childForFieldName("body");

  functions.push({
    name: fullName,
    kind: className ? "method" : "function",
    ...(className ? { class_name: className } : {}),
    start_line: outerStartLine ?? fnNode.startPosition.row + 1,
    end_line: fnNode.endPosition.row + 1,
    params: extractPythonParams(fnNode),
    is_exported: !rawName.startsWith("_"),
    raw_calls: extractPythonCalls(bodyNode),
  });
}

function extractPythonClass(classNode: Node, functions: ParsedFunction[]): void {
  const classNameNode = classNode.childForFieldName("name");
  const className = classNameNode?.text ?? "AnonymousClass";
  const bodyNode = classNode.childForFieldName("body");
  if (!bodyNode) return;

  for (const member of bodyNode.namedChildren) {
    if (!member) continue;
    if (member.type === "function_definition") {
      extractPythonFunction(member, functions, className);
    } else if (member.type === "decorated_definition") {
      const def = member.childForFieldName("definition");
      if (def?.type === "function_definition") {
        extractPythonFunction(def, functions, className, member.startPosition.row + 1);
      }
    }
  }
}

export const pythonAdapter: LanguageAdapter = {
  id: "python",

  extract(rootNode: Node): ExtractedAstData {
    const imports: ParsedImport[] = [];
    const functions: ParsedFunction[] = [];

    for (const stmt of rootNode.namedChildren) {
      if (!stmt) continue;
      switch (stmt.type) {
        case "import_statement":
        case "import_from_statement":
          extractPythonImport(stmt, imports);
          break;
        case "function_definition":
          extractPythonFunction(stmt, functions);
          break;
        case "class_definition":
          extractPythonClass(stmt, functions);
          break;
        case "decorated_definition": {
          const def = stmt.childForFieldName("definition");
          if (def?.type === "function_definition") {
            extractPythonFunction(def, functions, undefined, stmt.startPosition.row + 1);
          } else if (def?.type === "class_definition") {
            extractPythonClass(def, functions);
          }
          break;
        }
        default:
          break;
      }
    }

    return { imports, functions };
  },

  resolveImportTarget({ fromFilePath, importSource, allFilePaths }: ImportResolveContext): string | null {
    if (!importSource) return null;

    // Relative Python imports: `.auth`, `..services.auth`
    if (importSource.startsWith(".")) {
      const dotMatch = /^(\.+)(.*)$/.exec(importSource);
      if (!dotMatch) return null;
      const dots = dotMatch[1]!.length;
      const rest = dotMatch[2] ?? "";

      let baseDir = path.posix.dirname(fromFilePath);
      for (let i = 1; i < dots; i += 1) {
        baseDir = path.posix.dirname(baseDir);
      }

      const relPath = rest ? rest.replace(/\./g, "/") : "";
      const joined = path.posix.normalize(path.posix.join(baseDir, relPath));
      if (allFilePaths.has(`${joined}.py`)) return `${joined}.py`;
      if (allFilePaths.has(`${joined}/__init__.py`)) return `${joined}/__init__.py`;
      return null;
    }

    // Absolute module path: `app.services.auth` -> `app/services/auth.py` or `src/app/services/auth.py`
    const asPath = importSource.replace(/\./g, "/");
    const candidates = [
      `${asPath}.py`,
      `${asPath}/__init__.py`,
      `src/${asPath}.py`,
      `src/${asPath}/__init__.py`,
    ];
    for (const candidate of candidates) {
      if (allFilePaths.has(candidate)) return candidate;
    }

    // Suffix match for nested package roots
    for (const fp of allFilePaths) {
      if (fp.endsWith(`/${asPath}.py`) || fp.endsWith(`/${asPath}/__init__.py`)) {
        return fp;
      }
    }

    return null;
  },
};
