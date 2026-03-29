import { parse as parseYaml } from "yaml";
import type { z } from "zod";

/**
 * Result of parsing and validating YAML against a Zod schema.
 */
export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; errors: ParseError[] };

export interface ParseError {
  path: string;
  message: string;
}

/**
 * Parse a YAML string and validate it against a Zod schema.
 *
 * Returns structured errors with field paths for useful diagnostics.
 * Does not silently coerce broken values — fails explicitly.
 */
export function parseAndValidateYaml<T>(
  yamlString: string,
  schema: z.ZodType<T>,
): ParseResult<T> {
  let raw: unknown;

  try {
    raw = parseYaml(yamlString);
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: "",
          message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  if (raw === null || raw === undefined) {
    return {
      success: false,
      errors: [{ path: "", message: "YAML document is empty" }],
    };
  }

  const result = schema.safeParse(raw);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors: ParseError[] = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

  return { success: false, errors };
}

/**
 * Parse raw YAML without schema validation.
 * Returns the parsed object or structured error.
 */
export function parseYamlRaw(yamlString: string): ParseResult<unknown> {
  try {
    const data = parseYaml(yamlString);
    if (data === null || data === undefined) {
      return {
        success: false,
        errors: [{ path: "", message: "YAML document is empty" }],
      };
    }
    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: "",
          message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

/**
 * Format parse errors into a human-readable diagnostic string.
 */
export function formatParseErrors(errors: ParseError[]): string {
  return errors
    .map((e) => (e.path ? `  ${e.path}: ${e.message}` : `  ${e.message}`))
    .join("\n");
}
