import type { CodeMapNode } from "../../types/index.js";

export interface RelatedFunctionsResult {
  found: boolean;
  node?: CodeMapNode;
  callsTo: CodeMapNode[];
  calledBy: CodeMapNode[];
}

/**
 * Công cụ Tool Calling #2: xem_ham_lien_quan(node_id)
 * Tra cứu chiều xuôi (callsTo) và chiều ngược (calledBy) của một hàm trong code_map.
 */
export function xem_ham_lien_quan(
  nodeId: string,
  codeMap: CodeMapNode[]
): RelatedFunctionsResult {
  const target = codeMap.find((n) => n.node_id === nodeId);
  if (!target) {
    return { found: false, callsTo: [], calledBy: [] };
  }

  const nodeById = new Map(codeMap.map((n) => [n.node_id, n]));
  const callsTo = target.calls
    .map((id) => nodeById.get(id))
    .filter((n): n is CodeMapNode => Boolean(n));

  const calledBy = codeMap.filter((n) => n.calls.includes(nodeId));

  return {
    found: true,
    node: target,
    callsTo,
    calledBy,
  };
}
