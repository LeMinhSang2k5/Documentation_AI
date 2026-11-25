import type { Node } from "web-tree-sitter";
import type { ParsedFunction, ParsedImport } from "../../types/index.js";
import type { ExtractedAstData, LanguageAdapter } from "./types.js";

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "method_declaration",
  "method_definition",
  "constructor_declaration",
  "method",
]);

const CLASS_NODE_TYPES = new Set([
  "class_declaration",
  "class_definition",
  "class_specifier",
  "struct_declaration",
  "struct_specifier",
  "impl_item",
  "module",
]);

const CALL_NODE_TYPES = new Set([
  "call_expression",
  "method_invocation",
  "function_call_expression",
  "member_call_expression",
  "call",
]);

function extractGenericCalls(bodyNode: Node | null): string[] {
  if (!bodyNode) return [];
  const calls = new Set<string>();
  const stack: Node[] = [bodyNode];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (CALL_NODE_TYPES.has(current.type)) {
      const fnNode =
        current.childForFieldName("function") ??
        current.childForFieldName("name") ??
        current.childForFieldName("method") ??
        current.namedChildren[0];
      if (fnNode) {
        const objNode = current.childForFieldName("object");
        const callee = objNode ? `${objNode.text}.${fnNode.text}` : fnNode.text;
        if (callee && callee.length <= 120 && !callee.includes("\n")) {
          calls.add(callee);
        }
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

function walkGeneric(
  node: Node,
  imports: ParsedImport[],
  functions: ParsedFunction[],
  currentClass?: string
): void {
  if (
    node.type === "import_declaration" ||
    node.type === "import_spec" ||
    node.type === "use_declaration"
  ) {
    const sourceText = node.text
      .replace(/^(import|use)\s+/, "")
      .replace(/[;"]/g, "")
      .trim();
    if (sourceText) {
      imports.push({ source: sourceText, imported_names: [] });
    }
    return;
  }

  if (CLASS_NODE_TYPES.has(node.type)) {
    const nameNode =
      node.childForFieldName("name") ?? node.childForFieldName("type");
    const className = nameNode?.text ?? currentClass;
    for (const child of node.namedChildren) {
      if (child) walkGeneric(child, imports, functions, className);
    }
    return;
  }

  if (FUNCTION_NODE_TYPES.has(node.type)) {
    const nameNode =
      node.childForFieldName("name") ??
      node.childForFieldName("declarator")?.childForFieldName("declarator");
    const rawName = nameNode?.text;
    if (rawName) {
      const fullName = currentClass ? `${currentClass}.${rawName}` : rawName;
      const bodyNode = node.childForFieldName("body");
      functions.push({
        name: fullName,
        kind: currentClass ? "method" : "function",
        ...(currentClass ? { class_name: currentClass } : {}),
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        params: [],
        is_exported: true,
        raw_calls: extractGenericCalls(bodyNode),
      });
    }
    return;
  }

  for (const child of node.namedChildren) {
    if (child) walkGeneric(child, imports, functions, currentClass);
  }
}

export function createGenericAdapter(languageId: string): LanguageAdapter {
  return {
    id: languageId,
    extract(rootNode: Node): ExtractedAstData {
      const imports: ParsedImport[] = [];
      const functions: ParsedFunction[] = [];
      walkGeneric(rootNode, imports, functions);
      return { imports, functions };
    },
  };
}
