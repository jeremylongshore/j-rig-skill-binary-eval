/** Opt-in tool data redaction, not a PII scrubber or sandbox. */
export function observationRedactor(environment: NodeJS.ProcessEnv): (text: string) => string {
  const secrets = [
    ...new Set(
      Object.entries(environment)
        .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && !!value)
        .map(([, value]) => value!),
    ),
  ].sort((a, b) => b.length - a.length);
  function redactText(text: string): string {
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9+/=._-]+/gi, "$1[REDACTED]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
        "$1[REDACTED]",
      )
      .replace(/\b(?:sk-|gsk_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, "[REDACTED]");
  }
  function visit(value: unknown): unknown {
    if (typeof value === "string") {
      // MCP text may itself contain JSON; preserve its string representation.
      try {
        return JSON.stringify(visit(JSON.parse(value)));
      } catch {
        return redactText(value);
      }
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          redactText(key),
          /^(?:api[_-]?key|access[_-]?token|secret|password|authorization|credential)$/i.test(key)
            ? "[REDACTED]"
            : visit(entry),
        ]),
      );
    return value;
  }
  return (text) => {
    try {
      return JSON.stringify(visit(JSON.parse(text)));
    } catch {
      return redactText(text);
    }
  };
}
