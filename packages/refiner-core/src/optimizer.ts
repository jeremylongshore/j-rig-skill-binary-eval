import { z } from "zod";
import { applyEdit } from "./apply.js";
import { hashSkillDoc, hashValue } from "./hash.js";
import { validateEvalSet } from "./eval-set.js";
import type { EditProposal, EvalSet, SkillDoc } from "./types.js";

/** Canonical legacy optimizer contract, shared without a dependency on private @j-rig/core. */
export interface ChangeProposal {
  id: string;
  target_criterion: string;
  change_type: "description" | "instruction" | "example" | "trigger" | "constraint";
  description: string;
  rationale: string;
  expected_impact: string;
}
export type ExperimentStatus = "proposed" | "running" | "accepted" | "rejected" | "reverted";
export interface Experiment<TResult = unknown> {
  id: string;
  proposal: ChangeProposal;
  status: ExperimentStatus;
  before_results?: TResult[];
  after_results?: TResult[];
  improvement: boolean | null;
  created_at: string;
  resolved_at?: string;
  /** Bound experiments must use fresh Refiner assessment, never the legacy comparison gate. */
  refiner?: { skill: string; evalSet: string; editProposal: string };
}

const ChangeProposalSchema = z
  .object({
    id: z.string().min(1),
    target_criterion: z.string().min(1),
    change_type: z.enum(["description", "instruction", "example", "trigger", "constraint"]),
    description: z.string().min(1),
    rationale: z.string().min(1),
    expected_impact: z.string().min(1),
  })
  .strict();
const EditProposalSchema = z
  .object({
    parent: z.string().regex(/^[0-9a-f]{64}$/),
    ops: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("replace"), target: z.string().min(1), content: z.string() })
          .strict(),
        z
          .object({ kind: z.literal("add"), after: z.string().min(1), content: z.string() })
          .strict(),
        z.object({ kind: z.literal("delete"), target: z.string().min(1) }).strict(),
      ]),
    ),
    refinerModel: z.string().min(1),
    refinerStrategyId: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();
const SourceSchema = z
  .object({
    runId: z.number().int().positive().safe(),
    criterionId: z.string().min(1),
    /** Store address of retained run/skill/result evidence. */
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export interface RefinerExperiment {
  readonly schema: "refiner-optimizer/v1";
  /** Prior immutable experiment value's store address; null for a proposed root. */
  readonly parent: string | null;
  readonly experiment: Experiment;
  readonly doc: SkillDoc;
  readonly candidateDoc: SkillDoc;
  readonly evalSet: EvalSet;
  readonly editProposal: EditProposal;
  /** Explicit mapping from the legacy criterion to a reviewed frozen eval item. */
  readonly targetItemId: string;
  readonly source: z.infer<typeof SourceSchema>;
  readonly resolution?: {
    readonly assessmentHash: string;
    readonly baselineScoreHash: string;
    readonly candidateScoreHash: string;
    readonly reasons: readonly string[];
  };
}
export interface CreateRefinerExperimentInputs {
  readonly change: ChangeProposal;
  readonly doc: SkillDoc;
  readonly evalSet: EvalSet;
  readonly editProposal: EditProposal;
  readonly targetItemId: string;
  readonly source: RefinerExperiment["source"];
  readonly now: string;
}

/** One atomic edit, explicit target mapping and immutable content identities. No scoring or promotion. */
export function createRefinerExperiment(inputs: CreateRefinerExperimentInputs): RefinerExperiment {
  const frozen = structuredClone(inputs);
  const { doc, evalSet, targetItemId, now } = frozen;
  const editProposal = EditProposalSchema.parse(frozen.editProposal);
  const change = ChangeProposalSchema.parse(frozen.change);
  const source = SourceSchema.parse(frozen.source);
  if (!Number.isFinite(Date.parse(now))) throw new Error("optimizer experiment: invalid clock");
  if (hashSkillDoc(doc.text) !== doc.hash)
    throw new Error("optimizer experiment: invalid skill hash");
  validateEvalSet(evalSet);
  const {
    skillId,
    source: evalSource,
    items,
    evalSetVersion,
    lineageParent,
    refreshDueAt,
  } = evalSet;
  if (
    doc.skillId !== skillId ||
    evalSet.hash !==
      hashValue({ skillId, source: evalSource, items, evalSetVersion, lineageParent, refreshDueAt })
  )
    throw new Error("optimizer experiment: foreign or invalid eval set");
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some((item) => !item.expectation?.trim())
  )
    throw new Error("optimizer experiment: reviewed unique eval items required");
  if (
    !items.some((item) => item.id === targetItemId) ||
    change.target_criterion !== source.criterionId
  )
    throw new Error("optimizer experiment: invalid target mapping");
  if (!Array.isArray(editProposal.ops) || editProposal.ops.length !== 1)
    throw new Error("optimizer experiment: exactly one atomic edit required");
  const candidateDoc = applyEdit(doc, editProposal);
  if (candidateDoc.hash === doc.hash)
    throw new Error("optimizer experiment: edit must change the document");
  const binding = { skill: doc.hash, evalSet: evalSet.hash, editProposal: hashValue(editProposal) };
  const id = `exp-${hashValue({ change, binding, targetItemId, source })}`;
  return {
    schema: "refiner-optimizer/v1",
    parent: null,
    experiment: {
      id,
      proposal: change,
      status: "proposed",
      improvement: null,
      created_at: now,
      refiner: binding,
    },
    doc,
    candidateDoc,
    evalSet,
    editProposal,
    targetItemId,
    source,
  };
}

/** Reconstruct the proposed value before any evaluator I/O; reject tampered or resolved records. */
export function validateProposedRefinerExperiment(value: unknown): RefinerExperiment {
  if (!value || typeof value !== "object") throw new Error("optimizer experiment: missing value");
  const input = value as RefinerExperiment;
  if (
    input.schema !== "refiner-optimizer/v1" ||
    input.parent !== null ||
    input.experiment?.status !== "proposed" ||
    input.resolution !== undefined
  )
    throw new Error("optimizer experiment: expected an unresolved proposed value");
  const rebuilt = createRefinerExperiment({
    change: input.experiment.proposal,
    doc: input.doc,
    evalSet: input.evalSet,
    editProposal: input.editProposal,
    targetItemId: input.targetItemId,
    source: input.source,
    now: input.experiment.created_at,
  });
  if (hashValue(value) !== hashValue(rebuilt))
    throw new Error("optimizer experiment: content binding mismatch");
  return rebuilt;
}
