import type { CodeMapNode, DocItem } from "../types/index.js";

export type LLMProviderName = "gemini" | "openai" | "mock";
export type PromptVersion = "v1" | "v2" | "v3";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolCallLogEntry {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolExecutionContext {
  codeMap: CodeMapNode[];
  repoDir?: string;
  maxToolRounds?: number;
}

export interface LLMGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  expectJsonSchema?: boolean;
  toolContext?: ToolExecutionContext;
  mockContext?: {
    mode: "v1_raw" | "v2_structured";
    filePath: string;
    codeMap: CodeMapNode[];
    retryAttempt?: number;
  };
}

export interface LLMGenerateResponse {
  rawText: string;
  usage: TokenUsage;
  latencyMs: number;
  provider: LLMProviderName;
  model: string;
  toolCallsCount?: number;
  toolCallsLog?: ToolCallLogEntry[];
}

export interface MermaidCheckResult {
  valid: boolean;
  diagramType?: string;
  errors: string[];
  mermaidLiveUrl: string;
}

export interface VerificationResult {
  passed: boolean;
  invalidSourceNodeIds: string[];
  hallucinatedSymbols: string[];
  referencedSymbolCount: number;
  mermaidCheck: MermaidCheckResult;
  feedbackForRetry?: string;
}

export interface SelfCheckGenerationResult {
  document: DocItem;
  attemptsUsed: number;
  initialMermaidValid: boolean;
  finalVerification: VerificationResult;
  totalTokens: number;
  toolCallsCount: number;
  toolCallsLog: ToolCallLogEntry[];
}
