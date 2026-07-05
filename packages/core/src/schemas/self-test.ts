import { z } from "zod";

/**
 * A skill's deterministic self-test — the ground-truth check that its bundled
 * script (not the LLM) produces the correct verdicts.
 *
 * A heavy-hitter skill's value is usually "a deterministic script does the
 * logic; the model never guesses a number." Grading only the model reading
 * SKILL.md (single-turn completion) under-scores such a skill — it never runs
 * the classifier that produces the correct answers. Declaring a `self_test`
 * lets j-rig execute that script (opt-in, via `--run-self-test`) and fold its
 * exit-code verdict in as a deterministic, binary criterion — grading what the
 * script OBSERVABLY produces (design principle #3: observed behavior outranks
 * claimed behavior) with a separate evaluator (the script, not the model
 * judging itself).
 *
 * The pass/fail verdict is purely `exit_code === expect_exit`. `asserts` is
 * human-readable documentation of what the self-test covers; it is NOT
 * machine-checked here — the script owns its assertions.
 */
export const SelfTestSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .describe(
        "Command that runs the skill's deterministic self-test, relative to the skill " +
          'dir (e.g. "python3 scripts/triage.py --self-test"). Tokenized on whitespace and ' +
          "run WITHOUT a shell: the first token is the executable, the rest are argv.",
      ),
    expect_exit: z
      .number()
      .int()
      .default(0)
      .describe("Exit code that means the self-test passed (default 0)."),
    blocker: z
      .boolean()
      .default(true)
      .describe(
        "If true (default), a failing self-test blocks rollout and cannot be averaged " +
          "out — a broken deterministic core is not a soft signal.",
      ),
    asserts: z
      .array(z.string())
      .optional()
      .describe(
        "Human-readable list of what the self-test covers (documentation only; the " +
          "script owns the actual assertions — this list is never machine-checked).",
      ),
  })
  .strict();

export type SelfTest = z.infer<typeof SelfTestSchema>;

/** The reserved criterion id under which a self-test verdict is scored. */
export const SELF_TEST_CRITERION_ID = "self-test";
