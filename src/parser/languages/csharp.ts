import type { Node } from "web-tree-sitter";
import type { ParsedFunction, ParsedImport } from "../../types/index.js";
import type { ExtractedAstData, ImportResolveContext, LanguageAdapter } from "./types.js";

function extractCSharpParams(node: Node): string[] {
  const paramList = node.childForFieldName("parameters");
  if (!paramList) return [];
  const params: string[] = [];
  for (const child of paramList.namedChildren) {
    if (!child || child.type !== "parameter") continue;
    const nameNode = child.childForFieldName("name");
    if (nameNode) params.push(nameNode.text);
  }
  return params;
}

function hasPublicModifier(node: Node): boolean {
  for (const child of node.namedChildren) {
    if (child?.type === "modifier" && child.text === "public") {
      return true;
    }
  }
  return false;
}

function formatCSharpCallee(node: Node | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier":
    case "generic_name": {
      const id = node.type === "generic_name"
        ? node.namedChildren.find((c): c is Node => c !== null && c.type === "identifier")
        : node;
      return id?.text ?? node.text;
    }
    case "this_expression":
      return "this";
    case "member_access_expression": {
      const expr = node.childForFieldName("expression");
      const name = node.childForFieldName("name");
      if (!name) return null;
      const objName = formatCSharpCallee(expr);
      const propName = formatCSharpCallee(name);
      return objName && propName ? `${objName}.${propName}` : propName;
    }
    case "invocation_expression":
      return formatCSharpCallee(node.childForFieldName("function"));
    default:
      return null;
  }
}

function extractCSharpCalls(bodyNode: Node | null): string[] {
  if (!bodyNode) return [];
  const calls = new Set<string>();
  const stack: Node[] = [bodyNode];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (current.type === "invocation_expression") {
      const callee = formatCSharpCallee(current.childForFieldName("function"));
      if (callee) calls.add(callee);
    } else if (current.type === "object_creation_expression") {
      const typeNode = current.childForFieldName("type");
      const ctor = formatCSharpCallee(typeNode);
      if (ctor) calls.add(`new ${ctor}`);
    }

    const children = current.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }

  return Array.from(calls);
}

function walkCSharpNode(
  node: Node,
  imports: ParsedImport[],
  functions: ParsedFunction[],
  currentClass?: string
): void {
  switch (node.type) {
    case "using_directive": {
      const nameNode = node.namedChildren.find(
        (c): c is Node =>
          c !== null && (c.type === "qualified_name" || c.type === "identifier")
      );
      if (nameNode) {
        imports.push({
          source: nameNode.text,
          imported_names: [],
        });
      }
      return;
    }

    case "class_declaration":
    case "struct_declaration":
    case "record_declaration": {
      const nameNode = node.childForFieldName("name");
      const className = nameNode?.text ?? "AnonymousClass";
      const body = node.childForFieldName("body");
      if (body) {
        for (const member of body.namedChildren) {
          if (member) walkCSharpNode(member, imports, functions, className);
        }
      }
      return;
    }

    case "method_declaration":
    case "constructor_declaration": {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      const methodName =
        node.type === "constructor_declaration" ? "constructor" : nameNode.text;
      const fullName = currentClass ? `${currentClass}.${methodName}` : methodName;
      const body = node.childForFieldName("body") ?? node.namedChildren.find(
        (c): c is Node => c !== null && c.type === "arrow_expression_clause"
      ) ?? null;

      functions.push({
        name: fullName,
        kind: "method",
        ...(currentClass ? { class_name: currentClass } : {}),
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        params: extractCSharpParams(node),
        is_exported: hasPublicModifier(node),
        raw_calls: extractCSharpCalls(body),
      });
      return;
    }

    default: {
      for (const child of node.namedChildren) {
        if (child) walkCSharpNode(child, imports, functions, currentClass);
      }
    }
  }
}

export const csharpAdapter: LanguageAdapter = {
  id: "c_sharp",

  extract(rootNode: Node): ExtractedAstData {
    const imports: ParsedImport[] = [];
    const functions: ParsedFunction[] = [];
    walkCSharpNode(rootNode, imports, functions);
    return { imports, functions };
  },

  resolveImportTarget(_ctx: ImportResolveContext): string | null {
    // C# uses namespaces rather than file paths; callGraph resolves via symbol/class lookup
    return null;
  },
};
