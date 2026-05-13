/**
 * EC-3 — tool calling.
 *
 * Per PB-7 § 4 EC-3: give the model a tool schema (one function with three
 * parameters) and ask it to call the tool correctly given a prompt. Test
 * both legal tool-call generation AND a case where the model should
 * decline to call.
 *
 * Pass criterion per model:
 *   (1) when the prompt is a legitimate task for the tool, the model
 *       produces a tool call with valid arguments matching the schema
 *   (2) when the prompt is unrelated to the tool's purpose, the model
 *       does NOT call the tool (toolName === null is the success state)
 */
import type { Provider, CompletionRequest, ToolDefinition } from "../types.js";
import type { ECPerModelOutcome, ECRunner } from "./types.js";
import { DEFAULT_MODELS } from "./types.js";
import { isProviderError } from "../errors.js";

const SAMPLE_TOOL: ToolDefinition = {
  name: "create_calendar_event",
  description: "Schedule a calendar event with title, start_time, and duration_minutes.",
  inputSchema: {
    type: "object",
    required: ["title", "start_time", "duration_minutes"],
    properties: {
      title: { type: "string" },
      start_time: { type: "string", format: "date-time" },
      duration_minutes: { type: "integer", minimum: 1, maximum: 480 },
    },
    additionalProperties: false,
  },
};

const SHOULD_CALL_PROMPT =
  "Please schedule a meeting titled 'Project review' starting tomorrow at 2pm for 60 minutes.";

const SHOULD_NOT_CALL_PROMPT =
  "What is the capital of France? Answer in one word, no tool calls.";

export const runEC3: ECRunner = async (provider, options) => {
  const models = options?.models ?? DEFAULT_MODELS;
  const t0 = Date.now();
  const perModel: ECPerModelOutcome[] = [];

  for (const [vendor, model] of Object.entries(models)) {
    perModel.push(await runOne(provider, model, vendor));
  }

  return {
    ec: "EC-3",
    provider: provider.name,
    perModel,
    harnessOk: true,
    durationMs: Date.now() - t0,
  };
};

async function runOne(
  provider: Provider,
  model: string,
  vendor: string,
): Promise<ECPerModelOutcome> {
  // Phase 1: model SHOULD call the tool
  let callOk = false;
  let callNotes = "";
  try {
    const req: CompletionRequest & { tools: ToolDefinition[] } = {
      model,
      messages: [{ role: "user", content: SHOULD_CALL_PROMPT }],
      tools: [SAMPLE_TOOL],
      maxTokens: 256,
    };
    const r = await provider.callTool(req);
    if (r.toolName === SAMPLE_TOOL.name && r.toolArguments) {
      const args = r.toolArguments;
      callOk =
        typeof args.title === "string" &&
        typeof args.start_time === "string" &&
        typeof args.duration_minutes === "number";
      callNotes = callOk
        ? `called with title='${args.title}'`
        : `called but args malformed: ${JSON.stringify(args).slice(0, 80)}`;
    } else {
      callNotes = `expected tool call, got toolName=${r.toolName}`;
    }
  } catch (err) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor} phase=should-call: ${isProviderError(err) ? err.category : "error"}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Phase 2: model should NOT call the tool
  let declineOk = false;
  let declineNotes = "";
  try {
    const req: CompletionRequest & { tools: ToolDefinition[] } = {
      model,
      messages: [{ role: "user", content: SHOULD_NOT_CALL_PROMPT }],
      tools: [SAMPLE_TOOL],
      maxTokens: 64,
    };
    const r = await provider.callTool(req);
    declineOk = r.toolName === null;
    declineNotes = declineOk
      ? `correctly declined; text=${r.text.slice(0, 40)}`
      : `expected no call, got toolName=${r.toolName}`;
  } catch (err) {
    return {
      model,
      pass: false,
      notes: `vendor=${vendor} phase=should-not-call: ${isProviderError(err) ? err.category : "error"}`,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    model,
    pass: callOk && declineOk,
    notes: `vendor=${vendor}: should-call=${callOk ? "ok" : "fail"} (${callNotes}); should-not-call=${declineOk ? "ok" : "fail"} (${declineNotes})`,
    metric: { should_call_ok: callOk, should_not_call_ok: declineOk },
  };
}
