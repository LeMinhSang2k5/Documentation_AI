import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ParsedFunction, ParsedImport } from "../../types/index.js";
import type { ExtractedAstData, ImportResolveContext, LanguageAdapter } from "./types.js";

const TS_JS_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

function stripQuotes(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith("`") && raw.endsWith("`"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function extractParameterName(paramNode: Node): string | null {
  switch (paramNode.type) {
    case "required_parameter":
    case "optional_parameter": {
      const pattern = paramNode.childForFieldName("pattern");
      if (!pattern) return null;
      if (pattern.type === "rest_pattern") {
        const inner = pattern.namedChildren.find((c): c is Node => c !== null);
        return inner ? `...${inner.text}` : pattern.text;
      }
      return pattern.text;
    }
    case "assignment_pattern": {
      const left = paramNode.childForFieldName("left");
      return left ? extractParameterName(left) : null;
    }
    case "rest_pattern": {
      const inner = paramNode.namedChildren.find((c): c is Node => c !== null);
      return inner ? `...${inner.text}` : paramNode.text;
    }
    case "identifier":
    case "object_pattern":
    case "array_pattern":
      return paramNode.text;
    default:
      return null;
  }
}

function extractParams(fnNode: Node): string[] {
  const paramsNode = fnNode.childForFieldName("parameters");
  if (paramsNode) {
    const params: string[] = [];
    for (const child of paramsNode.namedChildren) {
      if (!child) continue;
      const name = extractParameterName(child);
      if (name) {
        params.push(name);
      }
    }
    return params;
  }

  const singleParam = fnNode.childForFieldName("parameter");
  if (singleParam) {
    const name = extractParameterName(singleParam);
    return name ? [name] : [];
  }

  return [];
}

function formatCallee(node: Node | null): string | null {
  if (!node) return null;

  switch (node.type) {
    case "identifier":
    case "property_identifier":
    case "private_property_identifier":
    case "this":
    case "super":
      return node.text;

    case "member_expression": {
      const obj = node.childForFieldName("object");
      const prop = node.childForFieldName("property");
      if (!prop) return null;

      const objName = formatCallee(obj);
      return objName ? `${objName}.${prop.text}` : prop.text;
    }

    case "call_expression":
      return formatCallee(node.childForFieldName("function"));

    case "new_expression":
      return formatCallee(node.childForFieldName("constructor"));

    case "await_expression":
    case "instantiation_expression":
    case "parenthesized_expression":
    case "non_null_expression":
    case "as_expression":
    case "satisfies_expression": {
      const inner = node.namedChildren.find((c): c is Node => c !== null);
      return formatCallee(inner ?? null);
    }

    default:
      return null;
  }
}

function extractRawCalls(bodyNode: Node | null, skipNestedNamedFunctions: boolean): string[] {
  if (!bodyNode) return [];

  const calls = new Set<string>();
  const stack: Node[] = [bodyNode];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    // Skip descending into nested named functions that are extracted as their own nodes
    if (skipNestedNamedFunctions && current !== bodyNode) {
      if (
        current.type === "function_declaration" ||
        current.type === "generator_function_declaration"
      ) {
        continue;
      }
      if (current.type === "variable_declarator") {
        const nameNode = current.childForFieldName("name");
        const valueNode = current.childForFieldName("value");
        if (
          nameNode?.type === "identifier" &&
          (valueNode?.type === "arrow_function" || valueNode?.type === "function_expression")
        ) {
          continue;
        }
      }
    }

    if (current.type === "call_expression") {
      const callee = formatCallee(current.childForFieldName("function"));
      if (callee) {
        calls.add(callee);
      }
    } else if (current.type === "new_expression") {
      const ctor = formatCallee(current.childForFieldName("constructor"));
      if (ctor) {
        calls.add(`new ${ctor}`);
      }
    } else if (
      current.type === "jsx_opening_element" ||
      current.type === "jsx_self_closing_element"
    ) {
      const tagName = formatCallee(current.childForFieldName("name"));
      // PascalCase JSX elements represent React/TSX components (skip native HTML tags like <div>)
      if (tagName && /^[A-Z]/.test(tagName)) {
        calls.add(tagName);
      }
    }

    const children = current.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) {
        stack.push(child);
      }
    }
  }

  return Array.from(calls);
}

/**
 * Extract named nested functions inside a parent function/method body
 * (e.g. `const analyzeRepo = async (req, res) => {}` inside `createDocsController`).
 */
function extractNestedFunctions(
  bodyNode: Node | null,
  parentName: string,
  functions: ParsedFunction[]
): void {
  if (!bodyNode || bodyNode.type !== "statement_block") return;

  for (const stmt of bodyNode.namedChildren) {
    if (!stmt) continue;

    if (
      stmt.type === "function_declaration" ||
      stmt.type === "generator_function_declaration"
    ) {
      const nameNode = stmt.childForFieldName("name");
      if (!nameNode) continue;
      const nestedName = `${parentName}.${nameNode.text}`;
      const nestedBody = stmt.childForFieldName("body");
      functions.push({
        name: nestedName,
        kind: "function",
        start_line: stmt.startPosition.row + 1,
        end_line: stmt.endPosition.row + 1,
        params: extractParams(stmt),
        is_exported: false,
        raw_calls: extractRawCalls(nestedBody, false),
      });
    } else if (
      stmt.type === "lexical_declaration" ||
      stmt.type === "variable_declaration"
    ) {
      for (const decl of stmt.namedChildren) {
        if (!decl || decl.type !== "variable_declarator") continue;
        const nameNode = decl.childForFieldName("name");
        const valueNode = decl.childForFieldName("value");
        if (!nameNode || nameNode.type !== "identifier" || !valueNode) continue;
        if (valueNode.type !== "arrow_function" && valueNode.type !== "function_expression") {
          continue;
        }

        const nestedName = `${parentName}.${nameNode.text}`;
        const nestedBody = valueNode.childForFieldName("body");
        functions.push({
          name: nestedName,
          kind: valueNode.type === "arrow_function" ? "arrow_function" : "function",
          start_line: decl.startPosition.row + 1,
          end_line: valueNode.endPosition.row + 1,
          params: extractParams(valueNode),
          is_exported: false,
          raw_calls: extractRawCalls(nestedBody, false),
        });
      }
    }
  }
}

function extractImport(importNode: Node): ParsedImport | null {
  const sourceNode = importNode.childForFieldName("source");
  if (!sourceNode) return null;

  const source = stripQuotes(sourceNode.text);
  const importedNames: string[] = [];
  const aliases: Record<string, string> = {};
  let defaultImport: string | undefined;
  let namespaceImport: string | undefined;

  const clause = importNode.namedChildren.find(
    (child): child is Node => child !== null && child.type === "import_clause"
  );

  if (clause) {
    for (const child of clause.namedChildren) {
      if (!child) continue;

      if (child.type === "identifier") {
        defaultImport = child.text;
      } else if (child.type === "namespace_import") {
        const nsId = child.namedChildren.find(
          (c): c is Node => c !== null && c.type === "identifier"
        );
        if (nsId) {
          namespaceImport = nsId.text;
        }
      } else if (child.type === "named_imports") {
        for (const spec of child.namedChildren) {
          if (!spec || spec.type !== "import_specifier") continue;
          const nameNode = spec.childForFieldName("name");
          const aliasNode = spec.childForFieldName("alias");
          if (nameNode) {
            const originalName = nameNode.text;
            const localName = aliasNode?.text ?? originalName;
            importedNames.push(localName);
            if (aliasNode && aliasNode.text !== originalName) {
              aliases[aliasNode.text] = originalName;
            }
          }
        }
      }
    }
  }

  const parsed: ParsedImport = {
    source,
    imported_names: importedNames,
  };

  if (Object.keys(aliases).length > 0) {
    parsed.aliases = aliases;
  }
  if (defaultImport !== undefined) {
    parsed.default_import = defaultImport;
  }
  if (namespaceImport !== undefined) {
    parsed.namespace_import = namespaceImport;
  }

  return parsed;
}

function extractReExportAsImport(exportNode: Node): ParsedImport | null {
  const sourceNode = exportNode.childForFieldName("source");
  if (!sourceNode) return null;

  const source = stripQuotes(sourceNode.text);
  const importedNames: string[] = [];
  const aliases: Record<string, string> = {};

  const clause = exportNode.namedChildren.find(
    (c): c is Node => c !== null && c.type === "export_clause"
  );
  if (clause) {
    for (const spec of clause.namedChildren) {
      if (!spec || spec.type !== "export_specifier") continue;
      const nameNode = spec.childForFieldName("name");
      const aliasNode = spec.childForFieldName("alias");
      if (nameNode) {
        const localName = aliasNode?.text ?? nameNode.text;
        importedNames.push(localName);
        if (aliasNode && aliasNode.text !== nameNode.text) {
          aliases[aliasNode.text] = nameNode.text;
        }
      }
    }
  }

  const parsed: ParsedImport = { source, imported_names: importedNames };
  if (Object.keys(aliases).length > 0) {
    parsed.aliases = aliases;
  }
  return parsed;
}

function extractFunctionDeclaration(
  fnNode: Node,
  isExported: boolean,
  functions: ParsedFunction[],
  fallbackName?: string
): void {
  const nameNode = fnNode.childForFieldName("name");
  const name = nameNode?.text ?? fallbackName;
  if (!name) return;

  const bodyNode = fnNode.childForFieldName("body");
  functions.push({
    name,
    kind: "function",
    start_line: fnNode.startPosition.row + 1,
    end_line: fnNode.endPosition.row + 1,
    params: extractParams(fnNode),
    is_exported: isExported,
    raw_calls: extractRawCalls(bodyNode, true),
  });

  extractNestedFunctions(bodyNode, name, functions);
}

function extractClassMethods(
  classNode: Node,
  isExported: boolean,
  functions: ParsedFunction[]
): void {
  const classNameNode = classNode.childForFieldName("name");
  const className = classNameNode?.text ?? "AnonymousClass";
  const bodyNode = classNode.childForFieldName("body");
  if (!bodyNode) return;

  for (const member of bodyNode.namedChildren) {
    if (!member) continue;

    if (member.type === "method_definition") {
      const methodNameNode = member.childForFieldName("name");
      if (!methodNameNode) continue;

      const fullName = `${className}.${methodNameNode.text}`;
      const methodBody = member.childForFieldName("body");
      functions.push({
        name: fullName,
        kind: "method",
        class_name: className,
        start_line: member.startPosition.row + 1,
        end_line: member.endPosition.row + 1,
        params: extractParams(member),
        is_exported: isExported,
        raw_calls: extractRawCalls(methodBody, true),
      });
      extractNestedFunctions(methodBody, fullName, functions);
    } else if (member.type === "public_field_definition") {
      const valueNode = member.childForFieldName("value");
      if (!valueNode) continue;
      if (valueNode.type !== "arrow_function" && valueNode.type !== "function_expression") {
        continue;
      }

      const fieldNameNode = member.childForFieldName("name");
      if (!fieldNameNode) continue;

      const fullName = `${className}.${fieldNameNode.text}`;
      const fieldBody = valueNode.childForFieldName("body");
      functions.push({
        name: fullName,
        kind: "method",
        class_name: className,
        start_line: member.startPosition.row + 1,
        end_line: member.endPosition.row + 1,
        params: extractParams(valueNode),
        is_exported: isExported,
        raw_calls: extractRawCalls(fieldBody, true),
      });
      extractNestedFunctions(fieldBody, fullName, functions);
    }
  }
}

function extractVariableFunctions(
  declNode: Node,
  isExported: boolean,
  functions: ParsedFunction[]
): void {
  for (const child of declNode.namedChildren) {
    if (!child || child.type !== "variable_declarator") continue;

    const nameNode = child.childForFieldName("name");
    const valueNode = child.childForFieldName("value");
    if (!nameNode || nameNode.type !== "identifier" || !valueNode) continue;

    if (valueNode.type === "arrow_function" || valueNode.type === "function_expression") {
      const bodyNode = valueNode.childForFieldName("body");
      functions.push({
        name: nameNode.text,
        kind: valueNode.type === "arrow_function" ? "arrow_function" : "function",
        start_line: child.startPosition.row + 1,
        end_line: valueNode.endPosition.row + 1,
        params: extractParams(valueNode),
        is_exported: isExported,
        raw_calls: extractRawCalls(bodyNode, true),
      });
      extractNestedFunctions(bodyNode, nameNode.text, functions);
    }
  }
}

function extractCommonJsRequire(declNode: Node, imports: ParsedImport[]): void {
  for (const child of declNode.namedChildren) {
    if (!child || child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    const valueNode = child.childForFieldName("value");
    if (!nameNode || !valueNode || valueNode.type !== "call_expression") continue;

    const callee = valueNode.childForFieldName("function");
    if (!callee || callee.text !== "require") continue;

    const args = valueNode.childForFieldName("arguments");
    const firstArg = args?.namedChildren.find((c): c is Node => c !== null);
    if (!firstArg || firstArg.type !== "string") continue;

    const source = stripQuotes(firstArg.text);
    const parsedImport: ParsedImport = {
      source,
      imported_names: [],
    };
    const aliases: Record<string, string> = {};

    if (nameNode.type === "identifier") {
      parsedImport.default_import = nameNode.text;
    } else if (nameNode.type === "object_pattern") {
      for (const prop of nameNode.namedChildren) {
        if (!prop) continue;
        if (prop.type === "shorthand_property_identifier_pattern") {
          parsedImport.imported_names.push(prop.text);
        } else if (prop.type === "pair_pattern") {
          const key = prop.childForFieldName("key");
          const val = prop.childForFieldName("value");
          if (key) {
            const localName = val?.type === "identifier" ? val.text : key.text;
            parsedImport.imported_names.push(localName);
            if (localName !== key.text) {
              aliases[localName] = key.text;
            }
          }
        }
      }
    }

    if (Object.keys(aliases).length > 0) {
      parsedImport.aliases = aliases;
    }
    imports.push(parsedImport);
  }
}

function collectTopLevelStatement(
  stmt: Node,
  isExported: boolean,
  imports: ParsedImport[],
  functions: ParsedFunction[]
): void {
  switch (stmt.type) {
    case "import_statement": {
      const parsedImport = extractImport(stmt);
      if (parsedImport) {
        imports.push(parsedImport);
      }
      return;
    }

    case "export_statement": {
      const reExport = extractReExportAsImport(stmt);
      if (reExport) {
        imports.push(reExport);
      }

      const declaration = stmt.childForFieldName("declaration");
      if (declaration) {
        collectTopLevelStatement(declaration, true, imports, functions);
        return;
      }

      const value = stmt.childForFieldName("value");
      if (value) {
        if (value.type === "function_declaration" || value.type === "function_expression") {
          extractFunctionDeclaration(value, true, functions, "default");
        } else if (value.type === "arrow_function") {
          const bodyNode = value.childForFieldName("body");
          functions.push({
            name: "default",
            kind: "arrow_function",
            start_line: stmt.startPosition.row + 1,
            end_line: value.endPosition.row + 1,
            params: extractParams(value),
            is_exported: true,
            raw_calls: extractRawCalls(bodyNode, true),
          });
          extractNestedFunctions(bodyNode, "default", functions);
        } else if (value.type === "class_declaration" || value.type === "class") {
          extractClassMethods(value, true, functions);
        }
      }
      return;
    }

    case "function_declaration":
    case "generator_function_declaration": {
      extractFunctionDeclaration(stmt, isExported, functions, isExported ? "default" : undefined);
      return;
    }

    case "class_declaration":
    case "abstract_class_declaration": {
      extractClassMethods(stmt, isExported, functions);
      return;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      extractCommonJsRequire(stmt, imports);
      extractVariableFunctions(stmt, isExported, functions);
      return;
    }

    case "expression_statement": {
      const expr = stmt.namedChildren.find((c): c is Node => c !== null);
      if (!expr || expr.type !== "assignment_expression") return;

      const left = expr.childForFieldName("left");
      const right = expr.childForFieldName("right");
      if (!left || !right) return;
      if (right.type !== "arrow_function" && right.type !== "function_expression") return;

      const leftText = left.text;
      let exportedName: string | null = null;
      if (leftText === "module.exports") {
        const fnName = right.childForFieldName("name")?.text;
        exportedName = fnName ?? "default";
      } else if (leftText.startsWith("exports.")) {
        exportedName = leftText.slice("exports.".length);
      } else if (leftText.startsWith("module.exports.")) {
        exportedName = leftText.slice("module.exports.".length);
      }

      if (exportedName) {
        const bodyNode = right.childForFieldName("body");
        functions.push({
          name: exportedName,
          kind: right.type === "arrow_function" ? "arrow_function" : "function",
          start_line: stmt.startPosition.row + 1,
          end_line: right.endPosition.row + 1,
          params: extractParams(right),
          is_exported: true,
          raw_calls: extractRawCalls(bodyNode, true),
        });
        extractNestedFunctions(bodyNode, exportedName, functions);
      }
      return;
    }

    default:
      return;
  }
}

function tryResolveCandidatePath(rawTarget: string, allFilePaths: Set<string>): string | null {
  const normalized = path.posix.normalize(rawTarget).replace(/^\/+/, "");
  if (allFilePaths.has(normalized)) {
    return normalized;
  }

  const stripped = normalized.replace(/\.(?:[cm]?js|jsx)$/i, "");
  for (const ext of TS_JS_EXTENSIONS) {
    const candidate = `${stripped}${ext}`;
    if (allFilePaths.has(candidate)) {
      return candidate;
    }
  }

  for (const ext of TS_JS_EXTENSIONS) {
    const indexCandidate = `${normalized}/index${ext}`;
    if (allFilePaths.has(indexCandidate)) {
      return indexCandidate;
    }
  }

  return null;
}

export const typescriptAdapter: LanguageAdapter = {
  id: "typescript",

  extract(rootNode: Node): ExtractedAstData {
    const imports: ParsedImport[] = [];
    const functions: ParsedFunction[] = [];

    for (const stmt of rootNode.namedChildren) {
      if (!stmt) continue;
      collectTopLevelStatement(stmt, false, imports, functions);
    }

    return { imports, functions };
  },

  resolveImportTarget({
    fromFilePath,
    importSource,
    allFilePaths,
    pathAliases,
  }: ImportResolveContext): string | null {
    // 1. Relative imports: "./auth", "../utils/logger.js"
    if (importSource.startsWith(".")) {
      const fromDir = path.posix.dirname(fromFilePath);
      const rawTarget = path.posix.join(fromDir, importSource);
      return tryResolveCandidatePath(rawTarget, allFilePaths);
    }

    // 2. tsconfig.json / jsconfig.json path aliases: "@/services/auth" -> "src/services/auth.ts"
    if (pathAliases) {
      for (const [pattern, targets] of Object.entries(pathAliases)) {
        const starIdx = pattern.indexOf("*");
        if (starIdx !== -1) {
          const prefix = pattern.slice(0, starIdx);
          const suffix = pattern.slice(starIdx + 1);
          if (importSource.startsWith(prefix) && importSource.endsWith(suffix)) {
            const matched = importSource.slice(
              prefix.length,
              suffix.length > 0 ? -suffix.length : undefined
            );
            for (const target of targets) {
              const expanded = target.replace("*", matched);
              const resolved = tryResolveCandidatePath(expanded, allFilePaths);
              if (resolved) return resolved;
            }
          }
        } else if (importSource === pattern) {
          for (const target of targets) {
            const resolved = tryResolveCandidatePath(target, allFilePaths);
            if (resolved) return resolved;
          }
        }
      }
    }

    return null;
  },
};
