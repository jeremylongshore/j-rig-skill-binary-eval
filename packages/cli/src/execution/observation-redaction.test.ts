import { describe, expect, it } from "vitest";
import { observationRedactor } from "./observation-redaction.js";

describe("observation credential redaction", () => {
  it("preserves full normal evidence and UUIDs while redacting nested credentials", () => {
    const secret = 'trial-credential-"\\-value';
    const redact = observationRedactor({ NVIDIA_API_KEY: secret });
    const draft = "ordinary draft ".repeat(100);
    const id = "847753e4-d988-49fa-b739-886b2b7c53b9";
    const content = redact(
      JSON.stringify({
        id,
        draft,
        password: "unexpected",
        content: [
          {
            text: JSON.stringify({
              run_id: id,
              saved: true,
              note: secret,
              authorization: "Bearer unknown",
            }),
          },
        ],
      }),
    );
    const result = JSON.parse(content);
    expect(result).toMatchObject({ id, draft, password: "[REDACTED]" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      run_id: id,
      saved: true,
      note: "[REDACTED]",
      authorization: "[REDACTED]",
    });
    expect(content).not.toContain("unexpected");
    expect(content).not.toContain("trial-credential");
    expect(redact("Bearer unrelated-token sk-testcredential")).toBe("Bearer [REDACTED] [REDACTED]");
  });
});
