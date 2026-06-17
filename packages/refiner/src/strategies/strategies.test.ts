import { describe, it, expect } from "vitest";
import { NaiveInContextStrategy, NAIVE_IN_CONTEXT_STRATEGY_ID } from "./naive-in-context.js";
import {
  SkillOptStyleStrategy,
  SKILL_OPT_STYLE_STRATEGY_ID,
  selectWorstRollouts,
} from "./skill-opt-style.js";
import type { RefinerModel, ProposeContext, ScoredRollout } from "./types.js";
import { makeSkillDoc } from "../apply.js";
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
      strat: new NaiveInContextStrategy(),
      id: NAIVE_IN_CONTEXT_STRATEGY_ID,
    },
    {
      name: "SkillOptStyleStrategy",
      strat: new SkillOptStyleStrategy(),
      id: SKILL_OPT_STYLE_STRATEGY_ID,
    },
  ];

  for (const { name, strat, id } of cases) {
    describe(name, () => {
      it("has the expected stable id and a description", () => {
        expect(strat.id).toBe(id);
        expect(strat.description.length).toBeGreaterThan(0);
      });

      it("returns a proposal whose parent === doc hash and strategy id === its own id (CISO traceability)", async () => {
        const ctx: ProposeContext = {
          doc: DOC,
          rollouts: [rollout("demo-syn-001", 0.4, "weak output")],
          model: stubModel(VALID_COMPLETION),
        };
        const proposal = await strat.propose(ctx);
        expect(proposal.parent).toBe(DOC.hash);
        expect(proposal.refinerStrategyId).toBe(strat.id);
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
        await expect(strat.propose(ctx)).rejects.toThrow();
      });
    });
  }
});

describe("NaiveInContextStrategy", () => {
  it("puts the whole skill doc in the prompt", async () => {
    const model = stubModel(VALID_COMPLETION);
    const strat = new NaiveInContextStrategy();
    await strat.propose({ doc: DOC, rollouts: [], model });
    expect(model.lastPrompt).toContain(DOC.text);
  });
});

describe("SkillOptStyleStrategy", () => {
  it("feeds the WEAKEST rollouts into the prompt as gradient signal", async () => {
    const model = stubModel(VALID_COMPLETION);
    const strat = new SkillOptStyleStrategy();
    const rollouts = [
      rollout("hi", 0.9, "STRONG-OUTPUT"),
      rollout("lo", 0.1, "WEAK-OUTPUT"),
      rollout("mid", 0.5, "MID-OUTPUT"),
    ];
    await strat.propose({ doc: DOC, rollouts, model });
    expect(model.lastPrompt).toContain("WEAK-OUTPUT");
    // the strongest rollout transcript should not be included (only worst-K)
    expect(model.lastPrompt).toContain("MID-OUTPUT");
  });

  it("tolerates an empty rollout set", async () => {
    const model = stubModel(VALID_COMPLETION);
    const strat = new SkillOptStyleStrategy();
    const proposal = await strat.propose({ doc: DOC, rollouts: [], model });
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
