import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import type { CodeMapNode } from "../types/index.js";
import { logger } from "../utils/logger.js";
import type {
  LLMGenerateRequest,
  LLMGenerateResponse,
  LLMProviderName,
} from "./harnessTypes.js";
import type { MetricsTracker } from "./metrics.js";
import { AI_DOCUMENT_JSON_SCHEMA } from "./schema.js";

export interface LLMClientConfig {
  provider?: LLMProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  metrics?: MetricsTracker;
}

export class LLMClient {
  private readonly provider: LLMProviderName;
  private activeModel: string;
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly metrics?: MetricsTracker;

  constructor(config: LLMClientConfig = {}) {
    const envProvider = (process.env.LLM_PROVIDER ?? "mock").toLowerCase() as LLMProviderName;
    this.provider = config.provider ?? envProvider;
    this.apiKey = config.apiKey ?? process.env.LLM_API_KEY ?? "";
    this.baseUrl = config.baseUrl ?? (process.env.LLM_BASE_URL || undefined);
    this.metrics = config.metrics;

    const defaultModel =
      this.provider === "openai" ? "gpt-4o-mini" : "gemini-3.8-flash";
    this.activeModel = config.model ?? (process.env.LLM_MODEL || defaultModel);
  }

  getProviderInfo(): { provider: LLMProviderName; model: string } {
    return { provider: this.provider, model: this.activeModel };
  }

  async generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse> {
    const startTime = Date.now();
    let response: LLMGenerateResponse;

    if (this.provider === "mock") {
      response = this.generateMock(request, startTime);
    } else if (this.provider === "gemini") {
      if (!this.apiKey || this.apiKey === "your-llm-api-key") {
        throw new Error(
          "Chưa cấu hình LLM_API_KEY cho Gemini trong file .env (hoặc chạy kèm cờ --mock để test offline)."
        );
      }
      response = await this.generateGemini(request, startTime);
    } else if (this.provider === "openai") {
      if (!this.apiKey || this.apiKey === "your-llm-api-key") {
        throw new Error(
          "Chưa cấu hình LLM_API_KEY cho OpenAI/OpenRouter trong file .env (hoặc chạy kèm cờ --mock để test offline)."
        );
      }
      response = await this.generateOpenAI(request, startTime);
    } else {
      throw new Error(`LLM_PROVIDER không hợp lệ: ${String(this.provider)}`);
    }

    this.metrics?.recordLLMUsage(response.usage);
    return response;
  }

  private async generateGemini(
    request: LLMGenerateRequest,
    startTime: number
  ): Promise<LLMGenerateResponse> {
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const candidateModels: string[] = [this.activeModel];
    let discoveredFallbacks = false;
    let lastError: unknown;

    for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
      const targetModel = candidateModels[mIdx];
      if (!targetModel) continue;
      const maxAttempts = 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await ai.models.generateContent({
            model: targetModel,
            contents: request.userPrompt,
            config: {
              systemInstruction: request.systemPrompt,
              temperature: 0.2,
              httpOptions: { timeout: 35_000 },
              ...(request.expectJsonSchema
                ? {
                    responseMimeType: "application/json",
                    responseJsonSchema: AI_DOCUMENT_JSON_SCHEMA,
                  }
                : {}),
            },
          });

          if (targetModel !== this.activeModel) {
            logger.info("Switched active Gemini model due to overload/availability", {
              previous_model: this.activeModel,
              active_model: targetModel,
            });
            this.activeModel = targetModel;
          }

          const rawText = res.text ?? "";
          const promptTokens =
            res.usageMetadata?.promptTokenCount ?? estimateTokens(request.userPrompt);
          const completionTokens =
            res.usageMetadata?.candidatesTokenCount ?? estimateTokens(rawText);

          return {
            rawText,
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
            latencyMs: Date.now() - startTime,
            provider: "gemini",
            model: targetModel,
          };
        } catch (err) {
          lastError = err;
          const errText = err instanceof Error ? err.message : String(err);
          const isOverloadedOrRateLimited =
            /"code":\s*(503|429)|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|abort|timed?\s*out|deadline/i.test(
              errText
            );
          const isModelNotFound =
            /"code":\s*404|NOT_FOUND|no longer available/i.test(errText);

          if (isOverloadedOrRateLimited && attempt < maxAttempts) {
            const delayMs = attempt * 3000;
            logger.warn("Gemini server busy (503/429), retrying automatically", {
              model: targetModel,
              retry_in_seconds: delayMs / 1000,
            });
            await sleep(delayMs);
            continue;
          }

          if ((isOverloadedOrRateLimited || isModelNotFound) && !discoveredFallbacks) {
            discoveredFallbacks = true;
            const fallbacks = await discoverAvailableGeminiFlashModels(
              this.apiKey,
              targetModel
            );
            if (fallbacks.length > 0) {
              logger.warn("Switching to fallback Gemini models", {
                from_model: targetModel,
                candidates: fallbacks,
              });
              candidateModels.push(...fallbacks);
            }
          }
          break;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async generateOpenAI(
    request: LLMGenerateRequest,
    startTime: number
  ): Promise<LLMGenerateResponse> {
    const endpointBase = (this.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const resp = await fetch(`${endpointBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.activeModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        ...(request.expectJsonSchema
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`OpenAI HTTP ${resp.status}: ${errBody}`);
    }

    const completion = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const rawText = completion.choices?.[0]?.message?.content ?? "";
    const promptTokens =
      completion.usage?.prompt_tokens ?? estimateTokens(request.userPrompt);
    const completionTokens =
      completion.usage?.completion_tokens ?? estimateTokens(rawText);

    return {
      rawText,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      latencyMs: Date.now() - startTime,
      provider: "openai",
      model: this.activeModel,
    };
  }

  private generateMock(
    request: LLMGenerateRequest,
    startTime: number
  ): LLMGenerateResponse {
    const ctx = request.mockContext;
    const filePath = ctx?.filePath ?? "src/sample.ts";
    const nodes: CodeMapNode[] = ctx?.codeMap ?? [];
    const fileNodes = nodes.filter((n) => n.file_path === filePath);
    const activeNodes = fileNodes.length > 0 ? fileNodes : nodes.slice(0, 3);
    const primaryNames = activeNodes.map((n) => `\`${n.name}\``).join(", ") || "`main`";
    const firstNodeName = activeNodes[0]?.name ?? "handle";

    let rawText: string;

    if (!request.expectJsonSchema || ctx?.mode === "v1_raw") {
      const hasHallucination = filePath.length % 2 === 0;
      const hallucinatedNote = hasHallucination
        ? "\n- Sau khi xử lý xong, hàm tự động gọi `AuditLogger.recordCloudEvent` và `CacheManager.invalidateTaskCache` để đồng bộ trạng thái."
        : "";

      const brokenMermaid = hasHallucination
        ? [
            "flowchart TD",
            `  Req[Nhận Request từ Client (${filePath})] --> Handler[Xử lý nghiệp vụ (${firstNodeName})]`,
            "  Handler --> DB: Lưu dữ liệu xuống Cloud",
          ].join("\n")
        : [
            "sequenceDiagram",
            "  participant Client",
            "  participant Module",
            `  Client->>Module: Gọi ${firstNodeName}`,
            "  Module-->>Client: Trả kết quả JSON",
          ].join("\n");

      rawText = [
        `# Tài liệu file \`${filePath}\``,
        "",
        "## Tổng quan",
        `File \`${filePath}\` chịu trách nhiệm xử lý các tác vụ cốt lõi thông qua ${primaryNames}.${hallucinatedNote}`,
        "",
        "```mermaid",
        brokenMermaid,
        "```",
      ].join("\n");
    } else {
      const retryAttempt = ctx?.retryAttempt ?? 0;
      const nodeIds = activeNodes.map((n) => n.node_id);
      const bulletList = activeNodes
        .map(
          (n) =>
            `- \`${n.name}\` (dòng ${n.start_line}–${n.end_line}): Thực thi nghiệp vụ chính của thành phần trong \`${n.file_path}\`.`
        )
        .join("\n");

      const mermaidDiagram =
        retryAttempt === 0 && filePath.toLowerCase().includes("auth")
          ? `flowchart TD\n  Start[Tiếp nhận yêu cầu (${firstNodeName})] --> Done["Hoàn tất"]`
          : buildCleanMockMermaid(activeNodes);

      rawText = JSON.stringify(
        {
          title: `Tài liệu kỹ thuật — ${filePath}`,
          markdown: [
            `## Tổng quan thành phần \`${filePath}\``,
            "",
            `Tài liệu mô tả chi tiết các thành phần có thật trong \`${filePath}\` dựa trên bản đồ mã nguồn.`,
            "",
            "## Danh sách hàm & phương thức",
            bulletList || `- Thành phần khởi tạo tại \`${filePath}\`.`,
            "",
            "## Luồng xử lý chính",
            `Yêu cầu đầu vào đi qua ${primaryNames} và trả về kết quả theo đúng hợp đồng dữ liệu của dự án.`,
          ].join("\n"),
          mermaid_diagram: mermaidDiagram,
          source_node_ids: nodeIds,
        },
        null,
        2
      );
    }

    const promptTokens = estimateTokens(request.systemPrompt + request.userPrompt);
    const completionTokens = estimateTokens(rawText);

    return {
      rawText,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      latencyMs: Math.max(1, Date.now() - startTime),
      provider: "mock",
      model: "mock-simulator-v1",
    };
  }
}

function buildCleanMockMermaid(nodes: CodeMapNode[]): string {
  if (nodes.length === 0) {
    return 'flowchart TD\n  Entry["Khởi tạo module"] --> Ready["Sẵn sàng xử lý"]';
  }
  const lines = ["flowchart TD", '  Client["Client / Caller"]'];
  nodes.forEach((node, idx) => {
    const safeId = `N${idx + 1}`;
    const safeLabel = node.name.replace(/"/g, "'");
    lines.push(`  ${safeId}["${safeLabel}"]`);
    if (idx === 0) {
      lines.push(`  Client --> ${safeId}`);
    } else {
      lines.push(`  N${idx} --> ${safeId}`);
    }
  });
  return lines.join("\n");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverAvailableGeminiFlashModels(
  apiKey: string,
  excludeModel: string
): Promise<string[]> {
  try {
    const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };

    const models = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter(
        (id) =>
          id.startsWith("gemini-") &&
          id !== excludeModel &&
          !/tts|image|vision|embedding|aqa|robotics|computer-use|live/i.test(id) &&
          /flash|pro/i.test(id)
      );

    models.sort((a, b) => {
      const rank = (name: string): number => {
        if (name.includes("flash-lite")) return 0;
        if (name.includes("flash")) return 1;
        return 2;
      };
      return rank(a) - rank(b) || b.localeCompare(a);
    });

    return models.slice(0, 4);
  } catch {
    return [];
  }
}
