import type { TokenUsage } from "./harnessTypes.js";

export interface RunSummaryMetrics {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalHallucinatedSymbols: number;
  totalReferencedSymbols: number;
  hallucinationRatePercent: number;
  diagramsChecked: number;
  diagramsValidBeforeRetry: number;
  diagramsValidAfterRetry: number;
  mermaidSuccessBeforePercent: number;
  mermaidSuccessAfterPercent: number;
}

export class MetricsTracker {
  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private hallucinatedSymbols = 0;
  private referencedSymbols = 0;
  private diagramsChecked = 0;
  private validBeforeRetry = 0;
  private validAfterRetry = 0;

  recordLLMUsage(usage: TokenUsage): void {
    this.calls += 1;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
  }

  recordDocumentCheck(params: {
    hallucinatedCount: number;
    referencedCount: number;
    validBeforeRetry: boolean;
    validAfterRetry: boolean;
  }): void {
    this.hallucinatedSymbols += params.hallucinatedCount;
    this.referencedSymbols += params.referencedCount;
    this.diagramsChecked += 1;
    if (params.validBeforeRetry) this.validBeforeRetry += 1;
    if (params.validAfterRetry) this.validAfterRetry += 1;
  }

  summarize(): RunSummaryMetrics {
    const totalTokens = this.promptTokens + this.completionTokens;
    const hallucinationRatePercent =
      this.referencedSymbols > 0
        ? Number(((this.hallucinatedSymbols / this.referencedSymbols) * 100).toFixed(2))
        : 0;
    const mermaidSuccessBeforePercent =
      this.diagramsChecked > 0
        ? Number(((this.validBeforeRetry / this.diagramsChecked) * 100).toFixed(2))
        : 0;
    const mermaidSuccessAfterPercent =
      this.diagramsChecked > 0
        ? Number(((this.validAfterRetry / this.diagramsChecked) * 100).toFixed(2))
        : 0;

    return {
      totalCalls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens,
      totalHallucinatedSymbols: this.hallucinatedSymbols,
      totalReferencedSymbols: this.referencedSymbols,
      hallucinationRatePercent,
      diagramsChecked: this.diagramsChecked,
      diagramsValidBeforeRetry: this.validBeforeRetry,
      diagramsValidAfterRetry: this.validAfterRetry,
      mermaidSuccessBeforePercent,
      mermaidSuccessAfterPercent,
    };
  }
}
