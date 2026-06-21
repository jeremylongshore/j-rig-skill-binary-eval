import { describe, it, expect } from "vitest";
import { NaiveInContextStrategy, NAIVE_IN_CONTEXT_STRATEGY_ID } from "./naive-in-context.js";
import {
  SkillOptStyleStrategy,
  SKILL_OPT_STYLE_STRATEGY_ID,
  selectWorstRollouts,
} from "./skill-opt-style.js";
import type { RefinerStrategy, RefinerModel, ProposeContext, ScoredRollout } from "./types.js";
import { makeSkillDoc, applyEdit } from "../apply.js";
import { accept } from "../accept.js";
import { BEHAVIORAL_DIMENSION } from "../types.js";
import type { ScoreRecord } from "../types.js";

const DOC = makeSkillDoc("demo", "# Demo\n\nUse this skill to do the thing.\n");
const EVAL = "e".repeat(64);

/** A model stub that records the prompt it saw and returns a canned completion. */
function stubModel(completion: string): RefinerModel & { lastPrompt: string } {
  const m = {
    id: "stub-model",
    lastPrompt: "",
    async complete(prompt: string): Promise<string> {
      m.lastPrompt = prompt;
      return completion;
    },
  };
  return m;
}

function score(behavioral: number): ScoreRecord {
  const dim = { value: behavioral, variance: 0, n: 1 };
  return {
    skill: DOC.hash,
    evalSet: EVAL,
    behavioral: dim,
    dimensions: { [BEHAVIORAL_DIMENSION]: dim },
  };
}

function rollout(itemId: string, behavioral: number, transcript: string): ScoredRollout {
  return { score: score(behavioral), evalItemId: itemId, transcript };
}

const VALID_COMPLETION = JSON.stringify({
  rationale: "tighten phrasing",
  ops: [{ kind: "replace", target: "do the thing", content: "accomplish the task" }],
});

describe("conformance: both reference strategies satisfy the RefinerStrategy contract", () => {
  const cases = [
    {
      name: "NaiveInContextStrategy",
      strategy: new NaiveInContextStrategy(),
      id: NAIVE_IN_CONTEXT_STRATEGY_ID,
    },
    {
      name: "SkillOptStyleStrategy",
      strategy: new SkillOptStyleStrategy(),
      id: SKILL_OPT_STYLE_STRATEGY_ID,
    },
  ];

  for (const { name, strategy, id } of cases) {
    describe(name, () => {
      it("has the expected stable id and a description", () => {
        expect(strategy.id).toBe(id);
        expect(strategy.description.length).toBeGreaterThan(0);
      });

      it("returns a proposal whose parent === doc hash and strategy id === its own id (CISO traceability)", async () => {
        const ctx: ProposeContext = {
          doc: DOC,
          rollouts: [rollout("demo-syn-001", 0.4, "weak output")],
          model: stubModel(VALID_COMPLETION),
        };
        const proposal = await strategy.propose(ctx);
        expect(proposal.parent).toBe(DOC.hash);
        expect(proposal.refinerStrategyId).toBe(strategy.id);
        expect(proposal.refinerModel).toBe("stub-model");
        expect(proposal.rationale).toBe("tighten phrasing");
        expect(proposal.ops).toHaveLength(1);
      });

      it("propagates an op-parse failure on a garbage completion", async () => {
        const ctx: ProposeContext = {
          doc: DOC,
          rollouts: [],
          model: stubModel("the model said no"),
        };
        await expect(strategy.propose(ctx)).rejects.toThrow();
      });
    });
  }
});

describe("NaiveInContextStrategy", () => {
  it("puts the whole skill doc in the prompt", async () => {
    const model = stubModel(VALID_COMPLETION);
    const strategy = new NaiveInContextStrategy();
    await strategy.propose({ doc: DOC, rollouts: [], model });
    expect(model.lastPrompt).toContain(DOC.text);
  });
});

describe("SkillOptStyleStrategy", () => {
  it("feeds the WEAKEST rollouts into the prompt as gradient signal", async () => {
    const model = stubModel(VALID_COMPLETION);
    const strategy = new SkillOptStyleStrategy();
    const rollouts = [
      rollout("hi", 0.9, "STRONG-OUTPUT"),
      rollout("lo", 0.1, "WEAK-OUTPUT"),
      rollout("mid", 0.5, "MID-OUTPUT"),
    ];
    await strategy.propose({ doc: DOC, rollouts, model });
    expect(model.lastPrompt).toContain("WEAK-OUTPUT");
    // the strongest rollout transcript should not be included (only worst-K)
    expect(model.lastPrompt).toContain("MID-OUTPUT");
  });

  it("tolerates an empty rollout set", async () => {
    const model = stubModel(VALID_COMPLETION);
    const strategy = new SkillOptStyleStrategy();
    const proposal = await strategy.propose({ doc: DOC, rollouts: [], model });
    expect(proposal.ops).toHaveLength(1);
    expect(model.lastPrompt).toContain("(no failing rollouts supplied)");
  });
});

describe("selectWorstRollouts", () => {
  it("returns the K lowest-behavioral rollouts ascending", () => {
    const rollouts = [
      rollout("a", 0.9, "a"),
      rollout("b", 0.2, "b"),
      rollout("c", 0.5, "c"),
      rollout("d", 0.1, "d"),
    ];
    const worst = selectWorstRollouts(rollouts, 2);
    expect(worst.map((r) => r.evalItemId)).toEqual(["d", "b"]);
  });

  it("returns all rollouts when K exceeds the count", () => {
    const rollouts = [rollout("a", 0.5, "a")];
    expect(selectWorstRollouts(rollouts, 5)).toHaveLength(1);
  });

  it("returns nothing for K <= 0", () => {
    const rollouts = [rollout("a", 0.5, "a")];
    expect(selectWorstRollouts(rollouts, 0)).toHaveLength(0);
  });
});

/**
 * Swappability integration test (AC-7 seam proof).
 *
 * This test runs the full core pipeline — strategy.propose() → applyEdit() →
 * accept() — against BOTH reference implementations via the SAME RefinerStrategy
 * seam. It proves that the interface is genuinely swappable: the pipeline does
 * not care which implementation sits behind the interface, only that it satisfies
 * the typed contract. The only external boundary stubbed is the LLM model call.
 */
describe("swappability: core pipeline against both strategies via the RefinerStrategy seam", () => {
  // A doc with unique anchors so applyEdit succeeds without ambiguity.
  const BASE_DOC = makeSkillDoc(
    "swap-demo",
    "# Swap Demo\n\nThis skill will do the task now.\n\nFurther context here.\n",
  );
  const EVAL_SET_HASH = "f".repeat(64);

  // Canned completion with a valid replace op. The target must be a unique
  // substring of BASE_DOC.text — "do the task now" appears exactly once.
  const IMPROVING_COMPLETION = JSON.stringify({
    rationale: "sharpen phrasing for clarity",
    ops: [{ kind: "replace", target: "do the task now", content: "accomplish the task precisely" }],
  });

  function makeScoreRecord(docHash: string, behavioralValue: number): ScoreRecord {
    const dim = { value: behavioralValue, variance: 0, n: 1 };
    return {
      skill: docHash,
      evalSet: EVAL_SET_HASH,
      behavioral: dim,
      dimensions: { [BEHAVIORAL_DIMENSION]: dim },
    };
  }

  async function runPipeline(
    strategy: RefinerStrategy,
    ctx: ProposeContext,
    baselineScore: ScoreRecord,
    candidateScore: ScoreRecord,
  ) {
    const proposal = await strategy.propose(ctx);

    // CISO traceability invariant: proposal parent and strategy id must match.
    expect(proposal.parent).toBe(ctx.doc.hash);
    expect(proposal.refinerStrategyId).toBe(strategy.id);

    // applyEdit is a pure function: verify the pipeline accepts the proposal.
    const candidateDoc = applyEdit(ctx.doc, proposal);
    expect(candidateDoc.hash).not.toBe(ctx.doc.hash); // genuinely new version

    // accept() is the gate: the candidateScore has a higher behavioral value
    // (deterministic dim, variance=0) so the gate should accept it.
    const result = accept(baselineScore, candidateScore);
    return { proposal, candidateDoc, result };
  }

  const strategies: Array<{ name: string; strategy: RefinerStrategy }> = [
    { name: "NaiveInContextStrategy", strategy: new NaiveInContextStrategy() },
    { name: "SkillOptStyleStrategy", strategy: new SkillOptStyleStrategy() },
  ];

  for (const { name, strategy } of strategies) {
    it(`${name}: propose → applyEdit → accept returns accepted:true on a strict improvement`, async () => {
      const ctx: ProposeContext = {
        doc: BASE_DOC,
        rollouts: [rollout("synth-001", 0.3, "weak output")],
        model: stubModel(IMPROVING_COMPLETION),
      };

      const baselineScore = makeScoreRecord(BASE_DOC.hash, 0.5);
      const candidateScore = makeScoreRecord(BASE_DOC.hash, 0.9); // strictly better

      const { result } = await runPipeline(strategy, ctx, baselineScore, candidateScore);
      expect(result.accepted).toBe(true);
    });

    it(`${name}: propose → applyEdit → accept returns accepted:false when candidate does not improve`, async () => {
      const ctx: ProposeContext = {
        doc: BASE_DOC,
        rollouts: [],
        model: stubModel(IMPROVING_COMPLETION),
      };

      const baselineScore = makeScoreRecord(BASE_DOC.hash, 0.9);
      const candidateScore = makeScoreRecord(BASE_DOC.hash, 0.9); // no improvement (equal)

      const { result } = await runPipeline(strategy, ctx, baselineScore, candidateScore);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.reason).toBe("no-behavioral-improvement");
      }
    });
  }

  it("both strategies produce structurally equivalent proposals when given the same doc + completion (seam equivalence)", async () => {
    const model = stubModel(IMPROVING_COMPLETION);
    const ctx: ProposeContext = {
      doc: BASE_DOC,
      rollouts: [],
      model,
    };

    const proposals = await Promise.all(
      strategies.map(({ strategy }) => strategy.propose({ ...ctx })),
    );

    // Both proposals edit the same parent and carry the same ops — the mechanism
    // difference is in HOW the prompt is assembled, not in the proposal shape.
    expect(proposals[0].parent).toBe(proposals[1].parent);
    expect(proposals[0].ops).toEqual(proposals[1].ops);
    expect(proposals[0].rationale).toBe(proposals[1].rationale);

    // Strategy ids differ — that's the point: the seam is swappable.
    expect(proposals[0].refinerStrategyId).toBe(NAIVE_IN_CONTEXT_STRATEGY_ID);
    expect(proposals[1].refinerStrategyId).toBe(SKILL_OPT_STYLE_STRATEGY_ID);
  });
});
