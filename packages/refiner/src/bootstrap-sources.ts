import {
  bootstrapFromItems,
  hashValue,
  hashSkillDoc,
  type BootstrapOptions,
  type EvalItem,
  type EvalSet,
  type SkillDoc,
} from "@intentsolutions/refiner-core";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("bootstrap source: expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("bootstrap source: expected nonempty text");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("bootstrap source: expected nonempty items");
  return value;
}
function identity(value: Record<string, unknown>, doc: SkillDoc): void {
  if (value.skillId !== doc.skillId || value.skillHash !== doc.hash)
    throw new Error("bootstrap source: foreign skill identity");
}

/** Review labels are explicit caller attestations, never inferred from observed output. */
export function bootstrapReviewedSource(
  doc: SkillDoc,
  sourceInput: unknown,
  reviewInput: unknown,
  sourceKind: "harvested" | "golden",
  opts: BootstrapOptions & { now: string },
): EvalSet {
  if (hashSkillDoc(doc.text) !== doc.hash) throw new Error("bootstrap source: invalid skill hash");
  const source = object(structuredClone(sourceInput));
  const review = object(structuredClone(reviewInput));
  identity(source, doc);
  identity(review, doc);
  const sourceHash = hashValue(source);
  const reviewHash = hashValue(review);
  if (
    review.schema !== "j-rig/bootstrap-review/v1" ||
    review.reviewed !== true ||
    review.sourceHash !== sourceHash
  )
    throw new Error("bootstrap source: missing or mismatched reviewed labels");
  const reviewedAt = Date.parse(text(review.reviewedAt));
  const now = Date.parse(opts.now);
  if (!Number.isFinite(now) || !Number.isFinite(reviewedAt) || reviewedAt > now)
    throw new Error("bootstrap source: invalid review time");
  const candidates = new Map<string, { prompt: string; runId?: number; model?: string }>();
  const add = (id: string, candidate: { prompt: string; runId?: number; model?: string }) => {
    if (candidates.has(id)) throw new Error("bootstrap source: duplicate source item");
    candidates.set(id, candidate);
  };
  if (sourceKind === "golden") {
    if (source.schema !== "j-rig/golden-traces/v1")
      throw new Error("bootstrap source: invalid golden schema");
    for (const raw of array(source.items)) {
      const item = object(raw);
      // A trace can be empty output, but must be an actual retained string.
      if (typeof item.output !== "string")
        throw new Error("bootstrap source: missing golden trace");
      add(text(item.id), { prompt: text(item.prompt) });
    }
  } else {
    if (source.schema !== "j-rig/rollouts/v1" || source.status !== "completed")
      throw new Error("bootstrap source: invalid rollout schema");
    const runIds = new Set<number>();
    for (const raw of array(source.runs)) {
      const run = object(raw);
      if (
        !Number.isSafeInteger(run.runId) ||
        (run.runId as number) < 1 ||
        runIds.has(run.runId as number)
      )
        throw new Error("bootstrap source: invalid or duplicate run identity");
      const runId = run.runId as number;
      runIds.add(runId);
      if (run.status !== "completed" || run.groundTruth !== true || text(run.provider) === "stub")
        throw new Error("bootstrap source: requires completed real-provider rollouts");
      const model = text(run.model);
      for (const rawOutcome of array(run.outcomes)) {
        const outcome = object(rawOutcome);
        if (outcome.status !== "completed" || typeof outcome.output !== "string")
          throw new Error("bootstrap source: incomplete rollout outcome");
        add(`run-${runId}:${text(outcome.id)}`, { prompt: text(outcome.prompt), runId, model });
      }
    }
  }
  const seen = new Set<string>();
  const items: EvalItem[] = array(review.items).map((raw) => {
    const label = object(raw);
    const id = text(label.id);
    const candidate = candidates.get(id);
    if (!candidate || seen.has(id))
      throw new Error("bootstrap source: unknown or duplicate reviewed item");
    seen.add(id);
    return {
      id,
      prompt: candidate.prompt,
      expectation: text(label.expectation),
      provenance: {
        sourceHash,
        reviewHash,
        sourceItemId: id,
        ...(candidate.runId === undefined
          ? {}
          : { runId: candidate.runId, model: candidate.model }),
      },
    };
  });
  return bootstrapFromItems(doc, sourceKind, items, opts);
}
