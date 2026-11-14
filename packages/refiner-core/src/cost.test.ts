/**
 * Cost meter tests — per-attempt accounting, per-accept rollup, and hard-cap
 * quarantine routing.
 *
 * Design: the unit under test is `createCostMeter`. The only external inputs
 * are `AttemptRecord` values (plain data) and `BudgetConfig` scalars. No model
 * is called; no stubs of the unit under test are used.
 */

import { describe, it, expect } from "vitest";
import {
  createCostMeter,
  totalTokens,
  type ModelUsage,
  type AttemptRecord,
  type BudgetConfig,
  type QuarantineRecord,
} from "./cost.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKILL_HASH = "a".repeat(64) as string;

function usage(promptTokens: number, completionTokens: number): ModelUsage {
  return { promptTokens, completionTokens };
}

function attempt(opts: Partial<AttemptRecord> & { usage: ModelUsage }): AttemptRecord {
  return {
    skillHash: SKILL_HASH,
    modelId: "stub-model",
    outcome: "rejected",
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// totalTokens utility
// ---------------------------------------------------------------------------

describe("totalTokens", () => {
  it("sums promptTokens and completionTokens", () => {
    expect(totalTokens(usage(100, 50))).toBe(150);
  });

  it("handles zeros", () => {
    expect(totalTokens(usage(0, 0))).toBe(0);
  });

  it("handles asymmetric counts", () => {
    expect(totalTokens(usage(1000, 1))).toBe(1001);
  });
});

// ---------------------------------------------------------------------------
// Per-attempt accounting
// ---------------------------------------------------------------------------

describe("per-attempt accounting", () => {
  it("starts empty with no attempts", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    expect(meter.attempts).toHaveLength(0);
    expect(meter.skillHash).toBe(SKILL_HASH);
  });

  it("records each attempt in insertion order", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(100, 50) }));
    meter.record(attempt({ usage: usage(200, 75) }));
    meter.record(attempt({ usage: usage(150, 60) }));
    expect(meter.attempts).toHaveLength(3);
    expect(meter.attempts[0].usage.promptTokens).toBe(100);
    expect(meter.attempts[1].usage.promptTokens).toBe(200);
    expect(meter.attempts[2].usage.promptTokens).toBe(150);
  });

  it("preserves the modelId and skillHash on each attempt", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(10, 5), modelId: "claude-haiku-4-5" }));
    meter.record(attempt({ usage: usage(20, 8), modelId: "claude-sonnet-4-5" }));
    expect(meter.attempts[0].modelId).toBe("claude-haiku-4-5");
    expect(meter.attempts[1].modelId).toBe("claude-sonnet-4-5");
  });

  it("preserves the outcome on each attempt", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(100, 50), outcome: "rejected" }));
    meter.record(attempt({ usage: usage(200, 75), outcome: "accepted" }));
    expect(meter.attempts[0].outcome).toBe("rejected");
    expect(meter.attempts[1].outcome).toBe("accepted");
  });

  it("returns detached snapshots and retains copies of recorded input", () => {
    const meter = createCostMeter(SKILL_HASH, { maxTotalTokens: 150 });
    const input = attempt({ usage: usage(100, 50) });
    meter.record(input);
    const snapshot = meter.attempts;
    Object.assign(input.usage, { promptTokens: 0 });
    Object.assign(input, { outcome: "accepted" });
    Object.assign(snapshot[0].usage, { completionTokens: 0 });
    (snapshot as AttemptRecord[]).splice(0);
    expect(meter.acceptRollup()).toMatchObject({
      totalTokens: 150,
      totalAttempts: 1,
      acceptedAttempts: 0,
    });
    expect(meter.checkBudget().continue).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-accept rollup
// ---------------------------------------------------------------------------

describe("acceptRollup", () => {
  it("returns zero-counts when no attempts are recorded", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    const rollup = meter.acceptRollup();
    expect(rollup.totalTokens).toBe(0);
    expect(rollup.totalPromptTokens).toBe(0);
    expect(rollup.totalCompletionTokens).toBe(0);
    expect(rollup.totalAttempts).toBe(0);
    expect(rollup.acceptedAttempts).toBe(0);
  });

  it("sums tokens across all attempts regardless of outcome", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(100, 50), outcome: "rejected" }));
    meter.record(attempt({ usage: usage(200, 75), outcome: "rejected" }));
    meter.record(attempt({ usage: usage(150, 60), outcome: "accepted" }));
    const rollup = meter.acceptRollup();
    expect(rollup.totalPromptTokens).toBe(450); // 100+200+150
    expect(rollup.totalCompletionTokens).toBe(185); // 50+75+60
    expect(rollup.totalTokens).toBe(635); // 450+185
    expect(rollup.totalAttempts).toBe(3);
    expect(rollup.acceptedAttempts).toBe(1);
  });

  it("counts multiple accepted attempts correctly", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(100, 50), outcome: "accepted" }));
    meter.record(attempt({ usage: usage(200, 75), outcome: "accepted" }));
    const rollup = meter.acceptRollup();
    expect(rollup.acceptedAttempts).toBe(2);
  });

  it("rollup reflects zero accepted attempts when all were rejected", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(100, 50), outcome: "rejected" }));
    meter.record(attempt({ usage: usage(200, 75), outcome: "rejected" }));
    const rollup = meter.acceptRollup();
    expect(rollup.acceptedAttempts).toBe(0);
    expect(rollup.totalAttempts).toBe(2);
    expect(rollup.totalTokens).toBe(425); // 150 + 275
  });
});

// ---------------------------------------------------------------------------
// Hard-cap: under-budget continues
// ---------------------------------------------------------------------------

describe("checkBudget — under-budget", () => {
  it("returns continue:true when no budget is configured", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(10000, 10000) }));
    expect(meter.checkBudget().continue).toBe(true);
  });

  it("returns continue:true when accumulated tokens are below the ceiling", () => {
    const meter = createCostMeter(SKILL_HASH, { maxTotalTokens: 1000 });
    meter.record(attempt({ usage: usage(300, 200) })); // 500 tokens
    expect(meter.checkBudget().continue).toBe(true);
  });

  it("returns continue:true when attempt count is below the ceiling", () => {
    const meter = createCostMeter(SKILL_HASH, { maxAttempts: 5 });
    meter.record(attempt({ usage: usage(10, 5) }));
    meter.record(attempt({ usage: usage(10, 5) }));
    expect(meter.checkBudget().continue).toBe(true);
  });

  it("returns continue:true before any attempts even with strict budgets", () => {
    const meter = createCostMeter(SKILL_HASH, { maxTotalTokens: 100, maxAttempts: 3 });
    expect(meter.checkBudget().continue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hard-cap: token ceiling fires → quarantine
// ---------------------------------------------------------------------------

describe("checkBudget — token ceiling exceeded → quarantine", () => {
  it("routes to quarantine when accumulated tokens meet the ceiling", () => {
    const meter = createCostMeter(SKILL_HASH, { maxTotalTokens: 500 });
    meter.record(attempt({ usage: usage(300, 200) })); // 500 tokens — AT ceiling
    const decision = meter.checkBudget();
    expect(decision.continue).toBe(false);
    if (!decision.continue) {
      const q: QuarantineRecord = decision.quarantine;
      expect(q.reason).toBe("token-ceiling-exceeded");
      expect(q.skillHash).toBe(SKILL_HASH);
      expect(q.attemptsAtCapFire).toBe(1);
      expect(q.usageAtCapFire.promptTokens).toBe(300);
      expect(q.usageAtCapFire.completionTokens).toBe(200);
      expect(q.budget.maxTotalTokens).toBe(500);
    }
  });

  it("routes to quarantine when accumulated tokens exceed the ceiling", () => {
    const meter = createCostMeter(SKILL_HASH, { maxTotalTokens: 100 });
    meter.record(attempt({ usage: usage(60, 50) })); // 110 tokens — over ceiling
    const decision = meter.checkBudget();
    expect(decision.continue).toBe(false);
    if (!decision.continue) {
      expect(decision.quarantine.reason).toBe("token-ceiling-exceeded");
      expect(totalTokens(decision.quarantine.usageAtCapFire)).toBe(110);
    }
  });

  it("quarantine usage reflects all accumulated attempts, not just the last", () => {
    const meter = createCostMeter(SKILL_HASH, { maxTotalTokens: 500 });
    meter.record(attempt({ usage: usage(150, 100) })); // 250
    meter.record(attempt({ usage: usage(150, 100) })); // 250 — total 500, AT ceiling
    const decision = meter.checkBudget();
    expect(decision.continue).toBe(false);
    if (!decision.continue) {
      expect(decision.quarantine.usageAtCapFire.promptTokens).toBe(300);
      expect(decision.quarantine.usageAtCapFire.completionTokens).toBe(200);
      expect(decision.quarantine.attemptsAtCapFire).toBe(2);
    }
  });

  it("quarantine carries the budget config that was in effect", () => {
    const budget: BudgetConfig = { maxTotalTokens: 100, maxAttempts: 10 };
    const meter = createCostMeter(SKILL_HASH, budget);
    meter.record(attempt({ usage: usage(60, 50) }));
    const decision = meter.checkBudget();
    if (!decision.continue) {
      expect(decision.quarantine.budget).toEqual(budget);
    }
  });
});

// ---------------------------------------------------------------------------
// Hard-cap: attempt ceiling fires → quarantine
// ---------------------------------------------------------------------------

describe("checkBudget — attempt ceiling exceeded → quarantine", () => {
  it("routes to quarantine when attempt count meets the ceiling", () => {
    const meter = createCostMeter(SKILL_HASH, { maxAttempts: 2 });
    meter.record(attempt({ usage: usage(100, 50) }));
    meter.record(attempt({ usage: usage(100, 50) })); // 2 attempts — AT ceiling
    const decision = meter.checkBudget();
    expect(decision.continue).toBe(false);
    if (!decision.continue) {
      expect(decision.quarantine.reason).toBe("attempt-ceiling-exceeded");
      expect(decision.quarantine.attemptsAtCapFire).toBe(2);
    }
  });

  it("routes to quarantine when attempt count exceeds the ceiling", () => {
    const meter = createCostMeter(SKILL_HASH, { maxAttempts: 1 });
    meter.record(attempt({ usage: usage(100, 50) }));
    meter.record(attempt({ usage: usage(100, 50) })); // 2 — over ceiling of 1
    const decision = meter.checkBudget();
    expect(decision.continue).toBe(false);
    if (!decision.continue) {
      expect(decision.quarantine.reason).toBe("attempt-ceiling-exceeded");
    }
  });

  it("quarantine carries all accumulated usage at cap-fire time", () => {
    const meter = createCostMeter(SKILL_HASH, { maxAttempts: 3 });
    meter.record(attempt({ usage: usage(100, 50) }));
    meter.record(attempt({ usage: usage(200, 75) }));
    meter.record(attempt({ usage: usage(150, 60) })); // 3 attempts — AT ceiling
    const decision = meter.checkBudget();
    if (!decision.continue) {
      expect(decision.quarantine.usageAtCapFire.promptTokens).toBe(450);
      expect(decision.quarantine.usageAtCapFire.completionTokens).toBe(185);
    }
  });
});

// ---------------------------------------------------------------------------
// Dual caps: attempt ceiling wins over token ceiling when both would fire
// ---------------------------------------------------------------------------

describe("checkBudget — dual caps, attempt ceiling checked first", () => {
  it("emits attempt-ceiling-exceeded when both caps are exceeded", () => {
    const meter = createCostMeter(SKILL_HASH, { maxTotalTokens: 10, maxAttempts: 1 });
    meter.record(attempt({ usage: usage(100, 50) })); // over BOTH ceilings
    const decision = meter.checkBudget();
    expect(decision.continue).toBe(false);
    if (!decision.continue) {
      // Attempt ceiling is checked first in the implementation
      expect(decision.quarantine.reason).toBe("attempt-ceiling-exceeded");
    }
  });
});

// ---------------------------------------------------------------------------
// Quarantine record shape contract
// ---------------------------------------------------------------------------

describe("QuarantineRecord shape invariants", () => {
  it("skillHash on quarantine matches the meter's skillHash", () => {
    const meter = createCostMeter(SKILL_HASH, { maxAttempts: 1 });
    meter.record(attempt({ usage: usage(10, 5) }));
    const decision = meter.checkBudget();
    if (!decision.continue) {
      expect(decision.quarantine.skillHash).toBe(SKILL_HASH);
    }
  });

  it("quarantine retains the original budget value as a detached snapshot", () => {
    const budget: BudgetConfig = { maxAttempts: 1 };
    const meter = createCostMeter(SKILL_HASH, budget);
    meter.record(attempt({ usage: usage(10, 5) }));
    const decision = meter.checkBudget();
    if (!decision.continue) {
      expect(decision.quarantine.budget).toEqual(budget);
      expect(decision.quarantine.budget).not.toBe(budget);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: typical pipeline pattern
// ---------------------------------------------------------------------------

describe("integration — typical propose-loop pattern", () => {
  it("pipeline stops when budget is exceeded and quarantine is observable", () => {
    // maxTotalTokens=300: after 2 attempts of 150 tokens each (300 total),
    // checkBudget fires (300 >= 300) and blocks the 3rd attempt.
    const budget: BudgetConfig = { maxTotalTokens: 300, maxAttempts: 5 };
    const meter = createCostMeter(SKILL_HASH, budget);
    const quarantineQueue: QuarantineRecord[] = [];

    const simulatedAttempts: ModelUsage[] = [
      usage(100, 50), // total after: 150
      usage(100, 50), // total after: 300 — ceiling is AT 300, so next check fires
      usage(100, 50), // would be 450 — but the loop should stop before recording this
    ];

    for (const u of simulatedAttempts) {
      const decision = meter.checkBudget();
      if (!decision.continue) {
        quarantineQueue.push(decision.quarantine);
        break;
      }
      meter.record(attempt({ usage: u, outcome: "rejected" }));
    }

    // The pipeline stopped before recording the 3rd attempt (300 tokens spent,
    // ceiling is 300, so checkBudget fires on the 3rd iteration before record).
    expect(meter.attempts).toHaveLength(2);
    expect(quarantineQueue).toHaveLength(1);
    expect(quarantineQueue[0].reason).toBe("token-ceiling-exceeded");
    expect(quarantineQueue[0].attemptsAtCapFire).toBe(2);
  });

  it("pipeline accepts a proposal and rollup reflects real cost", () => {
    const budget: BudgetConfig = { maxTotalTokens: 2000, maxAttempts: 10 };
    const meter = createCostMeter(SKILL_HASH, budget);

    // Simulate: 2 rejected proposals, then 1 accepted
    meter.record(attempt({ usage: usage(300, 150), outcome: "rejected" }));
    meter.record(attempt({ usage: usage(280, 140), outcome: "rejected" }));
    meter.record(attempt({ usage: usage(310, 155), outcome: "accepted" }));

    const rollup = meter.acceptRollup();
    expect(rollup.totalAttempts).toBe(3);
    expect(rollup.acceptedAttempts).toBe(1);
    expect(rollup.totalPromptTokens).toBe(890); // 300+280+310
    expect(rollup.totalCompletionTokens).toBe(445); // 150+140+155
    expect(rollup.totalTokens).toBe(1335);
    // Budget still has headroom
    expect(meter.checkBudget().continue).toBe(true);
  });
});

describe("cost accounting input integrity", () => {
  it.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid token value %s without recording an attempt",
    (value) => {
      const meter = createCostMeter(SKILL_HASH, {});
      for (const bad of [usage(value, 0), usage(0, value)]) {
        expect(() => totalTokens(bad)).toThrow();
        expect(() => meter.record(attempt({ usage: bad }))).toThrow();
      }
      expect(meter.attempts).toHaveLength(0);
    },
  );
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed caps %s",
    (value) => {
      expect(() => createCostMeter(SKILL_HASH, { maxAttempts: value })).toThrow();
      expect(() => createCostMeter(SKILL_HASH, { maxTotalTokens: value })).toThrow();
    },
  );
  it("isolates original, getter and quarantine budget snapshots", () => {
    const budget = { maxAttempts: 1, maxTotalTokens: 100 };
    const meter = createCostMeter(SKILL_HASH, budget);
    budget.maxAttempts = 99;
    Object.assign(meter.budget, { maxAttempts: 99 });
    meter.record(attempt({ usage: usage(1, 0) }));
    const decision = meter.checkBudget();
    expect(decision.continue).toBe(false);
    if (decision.continue) throw new Error("missing quarantine");
    Object.assign(decision.quarantine.budget, { maxAttempts: 999 });
    Object.assign(decision.quarantine.usageAtCapFire, { promptTokens: 999 });
    expect(meter.checkBudget()).toMatchObject({
      continue: false,
      quarantine: {
        reason: "attempt-ceiling-exceeded",
        attemptsAtCapFire: 1,
        usageAtCapFire: { promptTokens: 1, completionTokens: 0 },
        budget: { maxAttempts: 1 },
      },
    });
  });
  it("does not let a later record change an earlier attempts snapshot", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(1, 0) }));
    const earlier = meter.attempts;
    meter.record(attempt({ usage: usage(2, 0) }));
    expect(earlier).toHaveLength(1);
    expect(meter.attempts).toHaveLength(2);
  });
  it("rejects foreign skill, empty model, invalid outcome and malformed shapes", () => {
    const meter = createCostMeter(SKILL_HASH, {});
    for (const bad of [
      attempt({ usage: usage(1, 0), skillHash: "b".repeat(64) }),
      attempt({ usage: usage(1, 0), modelId: " " }),
      { ...attempt({ usage: usage(1, 0) }), outcome: "unknown" },
      { ...attempt({ usage: usage(1, 0) }), usage: null },
      null,
    ])
      expect(() => meter.record(bad as unknown as AttemptRecord)).toThrow();
    expect(meter.attempts).toHaveLength(0);
    expect(() => createCostMeter("invalid", {})).toThrow();
    expect(() => createCostMeter(SKILL_HASH, { maxToken: 5 } as unknown as BudgetConfig)).toThrow();
  });
  it("rejects per-call and aggregate overflow atomically", () => {
    expect(() => totalTokens(usage(Number.MAX_SAFE_INTEGER, 1))).toThrow();
    const meter = createCostMeter(SKILL_HASH, {});
    meter.record(attempt({ usage: usage(Number.MAX_SAFE_INTEGER - 1, 0) }));
    const before = meter.acceptRollup();
    expect(() => meter.record(attempt({ usage: usage(2, 0) }))).toThrow();
    expect(() => meter.record(attempt({ usage: usage(0, 2) }))).toThrow();
    expect(meter.acceptRollup()).toEqual(before);
    expect(meter.attempts).toHaveLength(1);
    meter.record(attempt({ usage: usage(0, 1) }));
    expect(meter.acceptRollup().totalTokens).toBe(Number.MAX_SAFE_INTEGER);
  });
});

it("preserves zero-cap admission and records already-incurred usage", () => {
  const meter = createCostMeter(SKILL_HASH, { maxAttempts: 0, maxTotalTokens: 0 });
  expect(meter.checkBudget()).toMatchObject({
    continue: false,
    quarantine: { reason: "attempt-ceiling-exceeded" },
  });
  meter.record(attempt({ usage: usage(0, 0) }));
  meter.record(attempt({ usage: usage(1, 1) }));
  expect(meter.acceptRollup()).toMatchObject({ totalAttempts: 2, totalTokens: 2 });
});
