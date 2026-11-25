import fs from "node:fs/promises";
import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ParsedFile, ParsedFunction, ParsedImport } from "../types/index.js";
import { createParserForFile } from "./core.js";

export function normalizeRelativePath(repoRoot: string, targetFilePath: string): string {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedFile = path.isAbsolute(targetFilePath)
    ? path.resolve(targetFilePath)
    : path.resolve(resolvedRoot, targetFilePath);

  const relative = path.relative(resolvedRoot, resolvedFile);
  return relative.split(path.sep).join("/");
}

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

  // Single unparenthesized parameter arrow function: x => x + 1
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

    case "call_expression": {
      // Collapse chained calls like `res.status(200).json(...)` -> `res.status.json`
      return formatCallee(node.childForFieldName("function"));
    }

    case "new_expression": {
      return formatCallee(node.childForFieldName("constructor"));
    }

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

function extractRawCalls(bodyNode: Node | null): string[] {
  if (!bodyNode) return [];

  const calls = new Set<string>();
  const stack: Node[] = [bodyNode];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

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
    }

    // Push in reverse so traversal visits children in source order
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

function extractImport(importNode: Node): ParsedImport | null {
  const sourceNode = importNode.childForFieldName("source");
  if (!sourceNode) return null;

  const source = stripQuotes(sourceNode.text);
  const importedNames: string[] = [];
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
          if (nameNode) {
            importedNames.push(nameNode.text);
          }
        }
      }
    }
  }

  const parsed: ParsedImport = {
    source,
    imported_names: importedNames,
  };

  if (defaultImport !== undefined) {
    parsed.default_import = defaultImport;
  }
  if (namespaceImport !== undefined) {
    parsed.namespace_import = namespaceImport;
  }

  return parsed;
}

function extractFunctionDeclaration(
  fnNode: Node,
  isExported: boolean,
  fallbackName?: string
): ParsedFunction | null {
  const nameNode = fnNode.childForFieldName("name");
  const name = nameNode?.text ?? fallbackName;
  if (!name) return null;

  return {
    name,
    kind: "function",
    start_line: fnNode.startPosition.row + 1,
    end_line: fnNode.endPosition.row + 1,
    params: extractParams(fnNode),
    is_exported: isExported,
    raw_calls: extractRawCalls(fnNode.childForFieldName("body")),
  };
}

function extractClassMethods(classNode: Node, isExported: boolean): ParsedFunction[] {
  const classNameNode = classNode.childForFieldName("name");
  const className = classNameNode?.text ?? "AnonymousClass";
  const bodyNode = classNode.childForFieldName("body");
  if (!bodyNode) return [];

  const methods: ParsedFunction[] = [];

  for (const member of bodyNode.namedChildren) {
    if (!member) continue;

    if (member.type === "method_definition") {
      const methodNameNode = member.childForFieldName("name");
      if (!methodNameNode) continue;

      methods.push({
        name: `${className}.${methodNameNode.text}`,
        kind: "method",
        class_name: className,
        start_line: member.startPosition.row + 1,
        end_line: member.endPosition.row + 1,
        params: extractParams(member),
        is_exported: isExported,
        raw_calls: extractRawCalls(member.childForFieldName("body")),
      });
    } else if (member.type === "public_field_definition") {
      const valueNode = member.childForFieldName("value");
      if (!valueNode) continue;
      if (valueNode.type !== "arrow_function" && valueNode.type !== "function_expression") {
        continue;
      }

      const fieldNameNode = member.childForFieldName("name");
      if (!fieldNameNode) continue;

      methods.push({
        name: `${className}.${fieldNameNode.text}`,
        kind: "method",
        class_name: className,
        start_line: member.startPosition.row + 1,
        end_line: member.endPosition.row + 1,
        params: extractParams(valueNode),
        is_exported: isExported,
        raw_calls: extractRawCalls(valueNode.childForFieldName("body")),
      });
    }
  }

  return methods;
}

function extractVariableFunctions(
  declNode: Node,
  isExported: boolean
): ParsedFunction[] {
  const functions: ParsedFunction[] = [];

  for (const child of declNode.namedChildren) {
    if (!child || child.type !== "variable_declarator") continue;

    const nameNode = child.childForFieldName("name");
    const valueNode = child.childForFieldName("value");
    if (!nameNode || nameNode.type !== "identifier" || !valueNode) continue;

    if (valueNode.type === "arrow_function" || valueNode.type === "function_expression") {
      functions.push({
        name: nameNode.text,
        kind: valueNode.type === "arrow_function" ? "arrow_function" : "function",
        start_line: child.startPosition.row + 1,
        end_line: valueNode.endPosition.row + 1,
        params: extractParams(valueNode),
        is_exported: isExported,
        raw_calls: extractRawCalls(valueNode.childForFieldName("body")),
      });
    }
  }

  return functions;
}

function extractCommonJsRequire(
  declNode: Node,
  imports: ParsedImport[]
): void {
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

    if (nameNode.type === "identifier") {
      parsedImport.default_import = nameNode.text;
    } else if (nameNode.type === "object_pattern") {
      for (const prop of nameNode.namedChildren) {
        if (!prop) continue;
        if (prop.type === "shorthand_property_identifier_pattern") {
          parsedImport.imported_names.push(prop.text);
        } else if (prop.type === "pair_pattern") {
          const key = prop.childForFieldName("key");
          if (key) parsedImport.imported_names.push(key.text);
        }
      }
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
      const declaration = stmt.childForFieldName("declaration");
      if (declaration) {
        collectTopLevelStatement(declaration, true, imports, functions);
        return;
      }

      // Handle `export default function() {}` or `export default () => {}`
      const value = stmt.childForFieldName("value");
      if (value) {
        if (value.type === "function_declaration" || value.type === "function_expression") {
          const parsedFn = extractFunctionDeclaration(value, true, "default");
          if (parsedFn) functions.push(parsedFn);
        } else if (value.type === "arrow_function") {
          functions.push({
            name: "default",
            kind: "arrow_function",
            start_line: stmt.startPosition.row + 1,
            end_line: value.endPosition.row + 1,
            params: extractParams(value),
            is_exported: true,
            raw_calls: extractRawCalls(value.childForFieldName("body")),
          });
        } else if (value.type === "class_declaration" || value.type === "class") {
          functions.push(...extractClassMethods(value, true));
        }
      }
      return;
    }

    case "function_declaration":
    case "generator_function_declaration": {
      const parsedFn = extractFunctionDeclaration(stmt, isExported, isExported ? "default" : undefined);
      if (parsedFn) {
        functions.push(parsedFn);
      }
      return;
    }

    case "class_declaration":
    case "abstract_class_declaration": {
      functions.push(...extractClassMethods(stmt, isExported));
      return;
    }

    case "lexical_declaration":
    case "variable_declaration": {
      extractCommonJsRequire(stmt, imports);
      functions.push(...extractVariableFunctions(stmt, isExported));
      return;
    }

    case "expression_statement": {
      // Handle CommonJS `module.exports = ...` or `exports.foo = (...) => {}`
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
        functions.push({
          name: exportedName,
          kind: right.type === "arrow_function" ? "arrow_function" : "function",
          start_line: stmt.startPosition.row + 1,
          end_line: right.endPosition.row + 1,
          params: extractParams(right),
          is_exported: true,
          raw_calls: extractRawCalls(right.childForFieldName("body")),
        });
      }
      return;
    }

    default:
      return;
  }
}

export async function parseSourceCode(
  sourceCode: string,
  relativeFilePath: string
): Promise<ParsedFile> {
  const normalizedPath = relativeFilePath.split("\\").join("/");
  const parser = await createParserForFile(normalizedPath);
  const tree = parser.parse(sourceCode);

  if (!tree) {
    parser.delete();
    throw new Error(`Tree-sitter returned null syntax tree for "${normalizedPath}"`);
  }

  try {
    const rootNode = tree.rootNode;
    const imports: ParsedImport[] = [];
    const functions: ParsedFunction[] = [];

    for (const stmt of rootNode.namedChildren) {
      if (!stmt) continue;
      collectTopLevelStatement(stmt, false, imports, functions);
    }

    return {
      file_path: normalizedPath,
      has_syntax_error: rootNode.hasError,
      imports,
      functions,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}

export async function parseSourceFile(
  repoRoot: string,
  targetFilePath: string
): Promise<ParsedFile> {
  const resolvedRoot = path.resolve(repoRoot);
  const absoluteFilePath = path.isAbsolute(targetFilePath)
    ? path.resolve(targetFilePath)
    : path.resolve(resolvedRoot, targetFilePath);

  const sourceCode = await fs.readFile(absoluteFilePath, "utf-8");
  const relativeFilePath = normalizeRelativePath(resolvedRoot, absoluteFilePath);

  return parseSourceCode(sourceCode, relativeFilePath);
}
