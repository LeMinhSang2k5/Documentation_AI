const REDACTED_KEYS = new Set([
  "x-api-key",
  "api_key",
  "apikey",
  "authorization",
  "supabase_service_role_key",
  "headers",
]);

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function formatLine(level: "INFO" | "WARN" | "ERROR", message: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const safeMeta = sanitizeMeta(meta);
  return safeMeta
    ? `[${ts}] [${level}] ${message} ${JSON.stringify(safeMeta)}`
    : `[${ts}] [${level}] ${message}`;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(formatLine("INFO", message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(formatLine("WARN", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(formatLine("ERROR", message, meta));
  },
};
