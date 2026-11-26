import "dotenv/config";
import {
  createPartFromFunctionResponse,
  GoogleGenAI,
  type Content,
  type Part,
} from "@google/genai";
import type { CodeMapNode } from "../types/index.js";
import { logger } from "../utils/logger.js";
import type {
  LLMGenerateRequest,
  LLMGenerateResponse,
  LLMProviderName,
  ToolCallLogEntry,
} from "./harnessTypes.js";
import type { MetricsTracker } from "./metrics.js";
import { AI_DOCUMENT_JSON_SCHEMA, AIDocumentOutputSchema } from "./schema.js";
import {
  executeHarnessTool,
  HARNESS_GEMINI_TOOL_DECLARATIONS,
  HARNESS_OPENAI_TOOLS,
} from "./tools/toolRegistry.js";

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
      this.provider === "openai" ? "gpt-4o-mini" : "gemini-2.5-flash";
    this.activeModel = config.model ?? (process.env.LLM_MODEL || defaultModel);
  }

  hasValidApiKey(): boolean {
    if (this.provider === "mock") return true;
    return Boolean(this.apiKey && this.apiKey !== "your-llm-api-key");
  }

  getProviderInfo(): { provider: LLMProviderName; model: string } {
    return { provider: this.provider, model: this.activeModel };
  }

  async generate(request: LLMGenerateRequest): Promise<LLMGenerateResponse> {
    const startTime = Date.now();
    let response: LLMGenerateResponse;

    if (this.provider === "mock") {
      response = await this.generateMock(request, startTime);
    } else if (this.provider === "gemini") {
      if (!this.hasValidApiKey()) {
        throw new Error(
          "Chưa cấu hình LLM_API_KEY cho Gemini trong file .env (hoặc chạy kèm cờ --mock để test offline)."
        );
      }
      response = await this.generateGemini(request, startTime);
    } else if (this.provider === "openai") {
      if (!this.hasValidApiKey()) {
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
          const result = await this.runGeminiConversation(ai, targetModel, request, startTime);
          if (targetModel !== this.activeModel) {
            logger.info("Switched active Gemini model due to overload/availability", {
              previous_model: this.activeModel,
              active_model: targetModel,
            });
            this.activeModel = targetModel;
          }
          return result;
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

  private async runGeminiConversation(
    ai: GoogleGenAI,
    targetModel: string,
    request: LLMGenerateRequest,
    startTime: number
  ): Promise<LLMGenerateResponse> {
    const toolCtx = request.toolContext;
    const toolCallsLog: ToolCallLogEntry[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Nếu không bật toolContext, gọi thẳng 1 lượt với Structured Output như cũ
    if (!toolCtx) {
      const res = await ai.models.generateContent({
        model: targetModel,
        contents: request.userPrompt,
        config: {
          systemInstruction: request.systemPrompt,
          temperature: 0.2,
          httpOptions: { timeout: 45_000 },
          ...(request.expectJsonSchema
            ? {
                responseMimeType: "application/json",
                responseJsonSchema: AI_DOCUMENT_JSON_SCHEMA,
              }
            : {}),
        },
      });

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
        toolCallsCount: 0,
        toolCallsLog: [],
      };
    }

    // Có bật Tool Calling (3 công cụ: doc_ma_nguon_ham, xem_ham_lien_quan, kiem_tra_cu_phap_so_do)
    const maxToolRounds = toolCtx.maxToolRounds ?? 10;
    const contents: Content[] = [
      {
        role: "user",
        parts: [{ text: request.userPrompt }],
      },
    ];

    let latestText = "";

    for (let round = 0; round < maxToolRounds; round++) {
      const res = await ai.models.generateContent({
        model: targetModel,
        contents,
        config: {
          systemInstruction: request.systemPrompt,
          temperature: 0.2,
          httpOptions: { timeout: 45_000 },
          tools: [{ functionDeclarations: HARNESS_GEMINI_TOOL_DECLARATIONS }],
        },
      });

      totalPromptTokens +=
        res.usageMetadata?.promptTokenCount ?? estimateTokens(request.userPrompt);
      totalCompletionTokens +=
        res.usageMetadata?.candidatesTokenCount ?? estimateTokens(res.text ?? "");

      const calls = res.functionCalls ?? [];
      if (calls.length === 0) {
        latestText = res.text ?? "";
        break;
      }

      const modelContent = res.candidates?.[0]?.content;
      if (modelContent) {
        contents.push(modelContent);
      }

      const responseParts: Part[] = [];
      for (const call of calls) {
        const fnName = call.name ?? "unknown_tool";
        const fnArgs = (call.args ?? {}) as Record<string, unknown>;
        toolCallsLog.push({ name: fnName, args: fnArgs });

        logger.info("AI Harness executing tool call", {
          tool: fnName,
          args: fnArgs,
        });

        const output = await executeHarnessTool(fnName, fnArgs, toolCtx);
        responseParts.push(
          createPartFromFunctionResponse(call.id ?? fnName, fnName, { result: output })
        );
      }

      contents.push({
        role: "user",
        parts: responseParts,
      });
    }

    // Nếu cần đảm bảo đầu ra khớp chặt AI_DOCUMENT_JSON_SCHEMA sau khi gọi tool xong:
    if (request.expectJsonSchema && !isValidStructuredDocumentJson(latestText)) {
      if (latestText.trim()) {
        contents.push({
          role: "model",
          parts: [{ text: latestText }],
        });
      }
      contents.push({
        role: "user",
        parts: [
          {
            text: "Dựa trên toàn bộ mã nguồn và thông tin vừa tra cứu từ công cụ, hãy xuất kết quả cuối cùng đúng định dạng JSON Schema gồm { title, specs, markdown, mermaid_diagram, source_node_ids }.",
          },
        ],
      });

      const finalRes = await ai.models.generateContent({
        model: targetModel,
        contents,
        config: {
          systemInstruction: request.systemPrompt,
          temperature: 0.2,
          httpOptions: { timeout: 45_000 },
          responseMimeType: "application/json",
          responseJsonSchema: AI_DOCUMENT_JSON_SCHEMA,
        },
      });

      latestText = finalRes.text ?? latestText;
      totalPromptTokens +=
        finalRes.usageMetadata?.promptTokenCount ?? estimateTokens(latestText);
      totalCompletionTokens +=
        finalRes.usageMetadata?.candidatesTokenCount ?? estimateTokens(latestText);
    }

    return {
      rawText: latestText,
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
      },
      latencyMs: Date.now() - startTime,
      provider: "gemini",
      model: targetModel,
      toolCallsCount: toolCallsLog.length,
      toolCallsLog,
    };
  }

  private async generateOpenAI(
    request: LLMGenerateRequest,
    startTime: number
  ): Promise<LLMGenerateResponse> {
    const endpointBase = (this.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const toolCtx = request.toolContext;
    const toolCallsLog: ToolCallLogEntry[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    type OpenAIMessage =
      | { role: "system" | "user"; content: string }
      | {
          role: "assistant";
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        }
      | { role: "tool"; tool_call_id: string; content: string };

    const messages: OpenAIMessage[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ];

    const maxRounds = toolCtx ? (toolCtx.maxToolRounds ?? 6) : 1;
    let rawText = "";

    for (let round = 0; round < maxRounds; round++) {
      const isLastRound = round === maxRounds - 1;
      const includeTools = Boolean(toolCtx) && !isLastRound;

      const resp = await fetch(`${endpointBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.activeModel,
          temperature: 0.2,
          messages,
          ...(includeTools ? { tools: HARNESS_OPENAI_TOOLS } : {}),
          ...(!includeTools && request.expectJsonSchema
            ? { response_format: { type: "json_object" } }
            : {}),
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`OpenAI HTTP ${resp.status}: ${errBody}`);
      }

      const completion = (await resp.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const msg = completion.choices?.[0]?.message;
      const content = msg?.content ?? "";
      totalPromptTokens +=
        completion.usage?.prompt_tokens ?? estimateTokens(request.userPrompt);
      totalCompletionTokens +=
        completion.usage?.completion_tokens ?? estimateTokens(content);

      const toolCalls = msg?.tool_calls ?? [];
      if (!toolCtx || toolCalls.length === 0) {
        rawText = content;
        break;
      }

      messages.push({
        role: "assistant",
        content: msg?.content ?? null,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          parsedArgs = {};
        }

        toolCallsLog.push({ name: tc.function.name, args: parsedArgs });
        logger.info("AI Harness executing OpenAI tool call", {
          tool: tc.function.name,
          args: parsedArgs,
        });

        const toolResult = await executeHarnessTool(tc.function.name, parsedArgs, toolCtx);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult),
        });
      }
    }

    if (toolCtx && request.expectJsonSchema && !isValidStructuredDocumentJson(rawText)) {
      if (rawText.trim()) {
        messages.push({ role: "assistant", content: rawText });
      }
      messages.push({
        role: "user",
        content:
          "Hãy xuất kết quả cuối cùng đúng định dạng JSON gồm { title, specs, markdown, mermaid_diagram, source_node_ids }.",
      });
      const finalResp = await fetch(`${endpointBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.activeModel,
          temperature: 0.2,
          messages,
          response_format: { type: "json_object" },
        }),
      });
      if (finalResp.ok) {
        const finalJson = (await finalResp.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        rawText = finalJson.choices?.[0]?.message?.content ?? rawText;
        totalPromptTokens += finalJson.usage?.prompt_tokens ?? 0;
        totalCompletionTokens += finalJson.usage?.completion_tokens ?? 0;
      }
    }

    return {
      rawText,
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
      },
      latencyMs: Date.now() - startTime,
      provider: "openai",
      model: this.activeModel,
      toolCallsCount: toolCallsLog.length,
      toolCallsLog,
    };
  }

  private async generateMock(
    request: LLMGenerateRequest,
    startTime: number
  ): Promise<LLMGenerateResponse> {
    const ctx = request.mockContext;
    const filePath = ctx?.filePath ?? "src/sample.ts";
    const nodes: CodeMapNode[] = ctx?.codeMap ?? [];
    const fileNodes = nodes.filter((n) => n.file_path === filePath);
    const activeNodes = fileNodes.length > 0 ? fileNodes : nodes.slice(0, 5);
    const primaryNames = activeNodes.map((n) => `\`${n.name}\``).join(", ") || "`main`";
    const firstNode = activeNodes[0];
    const firstNodeName = firstNode?.name ?? "handle";
    const toolCallsLog: ToolCallLogEntry[] = [];

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

      // Thực thi thật 3 công cụ tra cứu khi có toolContext để kiểm chứng toàn trình
      if (request.toolContext && firstNode) {
        const relArgs = { node_id: firstNode.node_id };
        toolCallsLog.push({ name: "xem_ham_lien_quan", args: relArgs });
        const relOut = await executeHarnessTool("xem_ham_lien_quan", relArgs, request.toolContext);

        const crossTarget = (
          (relOut.callsTo as CodeMapNode[] | undefined) ?? []
        ).find((target) => target.file_path !== filePath);
        const targetToRead = crossTarget?.node_id ?? firstNode.node_id;
        const readArgs = { node_id: targetToRead };
        toolCallsLog.push({ name: "doc_ma_nguon_ham", args: readArgs });
        await executeHarnessTool("doc_ma_nguon_ham", readArgs, request.toolContext);
      }

      const mermaidDiagram =
        retryAttempt === 0 && filePath.toLowerCase().includes("auth")
          ? `flowchart TD\n  Start[Tiếp nhận yêu cầu (${firstNodeName})] --> Done["Hoàn tất"]`
          : buildCleanMockMermaid(activeNodes);

      if (request.toolContext && retryAttempt > 0) {
        const checkArgs = { mermaid_code: mermaidDiagram };
        toolCallsLog.push({ name: "kiem_tra_cu_phap_so_do", args: checkArgs });
        await executeHarnessTool("kiem_tra_cu_phap_so_do", checkArgs, request.toolContext);
      }

      const fnDetailText = activeNodes
        .map((n) => {
          const callTargets = n.calls
            .map((cid) => nodes.find((x) => x.node_id === cid)?.name)
            .filter((name): name is string => Boolean(name));
          const callDesc =
            callTargets.length > 0
              ? `gọi tiếp tới ${callTargets.map((c) => `\`${c}\``).join(", ")}`
              : "thực thi xử lý cục bộ và trả kết quả";
          return `\`${n.name}\` (dòng ${n.start_line}–${n.end_line}, ${callDesc})`;
        })
        .join("; ");

      const specs = [
        {
          key: "Mục đích & Vai trò",
          value: `Thành phần \`${filePath}\` đảm nhận xử lý nghiệp vụ và điều phối dữ liệu thông qua ${primaryNames}.`,
        },
        {
          key: "Giao diện & Tham số (Inputs/Outputs)",
          value: `Tiếp nhận đầu vào qua các hàm thành phần ${primaryNames} và trả về dữ liệu chuẩn hóa theo hợp đồng của module.`,
        },
        {
          key: "Đặc tả chi tiết từng hàm",
          value: fnDetailText || `Khởi tạo cấu trúc cho \`${filePath}\`.`,
        },
        {
          key: "Luồng gọi hàm & Phụ thuộc",
          value: `Liên kết chặt chẽ giữa các hàm trong bản đồ mã nguồn (${primaryNames}) để đảm bảo tính nhất quán dữ liệu.`,
        },
        {
          key: "Kiểm tra hợp lệ & Xử lý lỗi",
          value: `Kiểm tra điều kiện đầu vào trước khi thực thi trong ${primaryNames} và trả trạng thái an toàn khi phát sinh ngoại lệ.`,
        },
      ];

      const bulletList = activeNodes
        .map(
          (n) =>
            `- \`${n.name}\` (dòng ${n.start_line}–${n.end_line}): Thực thi nghiệp vụ chính trong \`${n.file_path}\`.`
        )
        .join("\n");

      rawText = JSON.stringify(
        {
          title: `Tài liệu kỹ thuật — ${filePath}`,
          specs,
          markdown: [
            `## Tổng quan thành phần \`${filePath}\``,
            "",
            specs.map((s) => `- **${s.key}:** ${s.value}`).join("\n"),
            "",
            "## Danh sách hàm & phương thức",
            bulletList || `- Thành phần khởi tạo tại \`${filePath}\`.`,
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
      model: "mock-simulator-v3",
      toolCallsCount: toolCallsLog.length,
      toolCallsLog,
    };
  }
}

function isValidStructuredDocumentJson(raw: string): boolean {
  if (!raw.trim()) return false;
  const unwrapped = raw
    .trim()
    .replace(/^```(?:json)?\s*\r?\n?/i, "")
    .replace(/\r?\n?```\s*$/i, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(unwrapped);
    return AIDocumentOutputSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

function buildCleanMockMermaid(nodes: CodeMapNode[]): string {
  if (nodes.length === 0) {
    return 'flowchart TD\n  Entry["Khởi tạo module"] --> Ready["Sẵn sàng xử lý"]';
  }
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const edgeLines: string[] = [];

  for (const node of nodes) {
    for (const targetId of node.calls) {
      const target = byId.get(targetId);
      if (!target) continue;
      const fromLabel = node.name.replace(/"/g, "'");
      const toLabel = target.name.replace(/"/g, "'");
      edgeLines.push(`  ${node.node_id}["${fromLabel}"] --> ${target.node_id}["${toLabel}"]`);
    }
  }

  if (edgeLines.length > 0) {
    return ["flowchart LR", ...edgeLines.slice(0, 20)].join("\n");
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
