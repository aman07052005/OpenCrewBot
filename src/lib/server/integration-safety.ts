const SECRET_KEY = /authorization|token|secret|password|api[_-]?key/i;
const SECRET_TEXT = /\b(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,]+/gi;
const TOKEN_LIKE = /\b(sk|pk|rk|tvly|ak|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g;

/** Keep provider credentials out of integration errors, previews, and results. */
export function redactIntegrationText(value: string): string {
  return value.replace(TOKEN_LIKE, "[REDACTED]").replace(SECRET_TEXT, "$1=[REDACTED]");
}

export function redactIntegrationValue(value: unknown): unknown {
  if (typeof value === "string") return redactIntegrationText(value);
  if (Array.isArray(value)) return value.map(redactIntegrationValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redactIntegrationValue(item)]));
  }
  return value;
}
