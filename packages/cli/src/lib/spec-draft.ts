import { CriterionSchema, TestCaseSchema } from "@j-rig/core";

/**
 * Model-drafted functional criteria for `j-rig scaffold-spec --draft`.
 *
 * The deterministic baseline covers trigger engagement, output presence, and
 * prompt-leakage safety. What it cannot write is the part that needs to read
 * the skill: what a correct answer for THIS skill looks like. This module asks
 * a model for that, then keeps only what survives J-Rig's own schemas and
 * scoping rules. Everything it returns is a draft for a human to review; the
 * CLI tags the spec accordingly and never treats a draft as authoritative.
 */

/** The slice of the Refiner's CompletionClient this module needs. */
export interface DraftCompletionClient {
  complete(req: { model: string; prompt: string; maxTokens?: number }): Promise<string>;
}

/** Upper bounds keep a runaway response from producing an unreviewable spec. */
export const MAX_DRAFT_CRITERIA = 8;
export const MAX_DRAFT_TEST_CASES = 8;
const MAX_SKILL_CHARS = 12_000;

/** Prefix that marks every drafted id, so a reviewer can tell them apart. */
const DRAFT_PREFIX = "fn-";

export class SpecDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecDraftError";
  }
}

export interface DraftResult {
  criteria: Record<string, unknown>[];
  test_cases: Record<string, unknown>[];
  /** One human-readable line per item the model returned that was not kept. */
  dropped: string[];
}

/** The instruction sent to the drafting model. */
export function buildDraftPrompt(skillName: string, skillMd: string): string {
  const body =
    skillMd.length <= MAX_SKILL_CHARS
      ? skillMd
      : `${skillMd.slice(0, MAX_SKILL_CHARS)}\n[... truncated ...]`;
  return [
    `You are drafting a behavioral evaluation for the Claude skill "${skillName}".`,
    "Read the SKILL.md below and propose functional criteria and test cases that check",
    "whether a response to a realistic user request actually does what this skill promises.",
    "",
    "Rules:",
    "- Each criterion is ONE checkable binary claim about the response (yes/no), never a",
    "  1-to-5 scale and never a bundle of several claims.",
    "- Each criterion has a judge_prompt: a yes/no question a separate grader model answers",
    "  after reading the user prompt and the response. Phrase it so 'yes' means the response",
    "  is correct.",
    '- Mark "blocker": true only for claims whose failure makes the response wrong or unsafe.',
    "- Test cases are realistic user requests. Include some that a human expert would judge",
    "  hard (ambiguous input, missing information, an edge the SKILL.md calls out), not only",
    "  easy ones. Use tier 'core' for typical requests and 'edge' for hard ones.",
    "- A test case prompt must not contain the answer, the criteria, or grading hints.",
    "- Every test case lists the criterion ids it should be graded on.",
    `- At most ${MAX_DRAFT_CRITERIA} criteria and ${MAX_DRAFT_TEST_CASES} test cases.`,
    "",
    "Respond with ONLY a JSON object, no prose, in exactly this shape:",
    '{"criteria":[{"id":"kebab-id","description":"...","blocker":false,"judge_prompt":"...?"}],',
    ' "test_cases":[{"id":"kebab-id","description":"...","tier":"core","prompt":"...","criteria_ids":["kebab-id"]}]}',
    "",
    "SKILL.md:",
    "<<<",
    body,
    ">>>",
  ].join("\n");
}

/** Pull the first JSON object out of a model response (fenced or bare). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new SpecDraftError("model response contained no JSON object");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (e) {
    throw new SpecDraftError(
      `model response JSON did not parse: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function kebab(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function draftId(raw: unknown, fallback: string): string {
  const k = kebab(raw) || fallback;
  return k.startsWith(DRAFT_PREFIX) ? k : `${DRAFT_PREFIX}${k}`;
}

/**
 * Turn a parsed model response into spec items that J-Rig will accept.
 *
 * Kept: judge-method criteria that validate and are graded by at least one
 * kept test case; `core`/`edge` test cases that validate and reference at
 * least one kept criterion. Criteria are forced to `method: judge` (a drafted
 * deterministic check id could name a check that does not exist). Test cases
 * get no trigger expectation (trigger coverage stays with the baseline) and
 * always include the baseline's `output-not-empty` criterion.
 */
export function normalizeDraft(
  parsed: unknown,
  reservedIds: ReadonlySet<string>,
  outputNotEmptyId = "output-not-empty",
): DraftResult {
  const dropped: string[] = [];
  const obj = (parsed ?? {}) as { criteria?: unknown; test_cases?: unknown };
  const rawCriteria = Array.isArray(obj.criteria) ? obj.criteria : [];
  const rawCases = Array.isArray(obj.test_cases) ? obj.test_cases : [];

  const idMap = new Map<string, string>();
  const used = new Set(reservedIds);
  const criteria: Record<string, unknown>[] = [];
  rawCriteria.forEach((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>;
    const label = typeof c.id === "string" ? c.id : `criteria[${i}]`;
    if (criteria.length >= MAX_DRAFT_CRITERIA) {
      dropped.push(`criterion ${label}: over the ${MAX_DRAFT_CRITERIA}-criterion cap`);
      return;
    }
    const id = draftId(c.id, `criterion-${i + 1}`);
    if (used.has(id)) {
      dropped.push(`criterion ${label}: duplicate id ${id}`);
      return;
    }
    const candidate = {
      id,
      description: c.description,
      method: "judge",
      blocker: c.blocker === true,
      judge_prompt: c.judge_prompt,
    };
    const result = CriterionSchema.safeParse(candidate);
    if (!result.success || typeof c.judge_prompt !== "string" || !c.judge_prompt.trim()) {
      dropped.push(`criterion ${label}: missing description or judge_prompt`);
      return;
    }
    used.add(id);
    idMap.set(kebab(c.id), id);
    idMap.set(id, id);
    criteria.push(candidate);
  });

  const referenced = new Set<string>();
  const test_cases: Record<string, unknown>[] = [];
  rawCases.forEach((item, i) => {
    const t = (item ?? {}) as Record<string, unknown>;
    const label = typeof t.id === "string" ? t.id : `test_cases[${i}]`;
    if (test_cases.length >= MAX_DRAFT_TEST_CASES) {
      dropped.push(`test case ${label}: over the ${MAX_DRAFT_TEST_CASES}-case cap`);
      return;
    }
    const tier = t.tier === "edge" ? "edge" : t.tier === "core" ? "core" : null;
    if (!tier) {
      dropped.push(`test case ${label}: tier must be core or edge`);
      return;
    }
    const mapped = (Array.isArray(t.criteria_ids) ? t.criteria_ids : [])
      .map((cid) => idMap.get(kebab(cid)))
      .filter((cid): cid is string => cid !== undefined);
    const criteriaIds = [...new Set(mapped)];
    if (criteriaIds.length === 0) {
      dropped.push(`test case ${label}: references no kept criterion`);
      return;
    }
    const id = draftId(t.id, `case-${i + 1}`);
    if (used.has(id)) {
      dropped.push(`test case ${label}: duplicate id ${id}`);
      return;
    }
    const candidate = {
      id,
      description: t.description,
      tier,
      prompt: t.prompt,
      criteria_ids: [outputNotEmptyId, ...criteriaIds],
    };
    if (!TestCaseSchema.safeParse(candidate).success) {
      dropped.push(`test case ${label}: missing description or prompt`);
      return;
    }
    used.add(id);
    criteriaIds.forEach((cid) => referenced.add(cid));
    test_cases.push(candidate);
  });

  const gradedCriteria = criteria.filter((c) => {
    if (referenced.has(c.id as string)) return true;
    dropped.push(`criterion ${String(c.id)}: no kept test case grades it`);
    return false;
  });

  return { criteria: gradedCriteria, test_cases, dropped };
}

/**
 * Ask the model for a draft and normalize it. Fails closed: when no criterion
 * survives, throw rather than hand back a spec with nothing drafted in it.
 */
export async function draftFunctionalItems(opts: {
  client: DraftCompletionClient;
  model: string;
  skillName: string;
  skillMd: string;
  reservedIds: ReadonlySet<string>;
  maxTokens?: number;
}): Promise<DraftResult> {
  const text = await opts.client.complete({
    model: opts.model,
    prompt: buildDraftPrompt(opts.skillName, opts.skillMd),
    maxTokens: opts.maxTokens ?? 4096,
  });
  const draft = normalizeDraft(extractJsonObject(text), opts.reservedIds);
  if (draft.criteria.length === 0) {
    const why = draft.dropped.length > 0 ? `: ${draft.dropped.join("; ")}` : "";
    throw new SpecDraftError(`the model's draft had no usable functional criteria${why}`);
  }
  return draft;
}
