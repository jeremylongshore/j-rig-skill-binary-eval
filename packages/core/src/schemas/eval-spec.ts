import { z } from "zod";
import { CriterionSchema } from "./criterion.js";
import { SELF_TEST_CRITERION_ID, SelfTestSchema } from "./self-test.js";
import { TestCaseSchema } from "./test-case.js";

/**
 * Models that can be tested independently.
 *
 * `haiku` / `sonnet` / `opus` are short aliases the Anthropic adapter resolves to
 * concrete Claude API ids. Any other non-empty identifier is accepted verbatim
 * so the same eval spec can target an OpenAI-compatible provider — DeepSeek
 * (`deepseek-chat`, `deepseek-reasoner`), Kimi/Moonshot (`kimi-k2-*`), or
 * OpenRouter (`<org>/<model>`). The chosen provider is selected at runtime from
 * the env key / `--provider` flag; this field only records WHICH model id the
 * adapter passes through. A fully-qualified, dated Claude id (`claude-…`) also
 * passes through here and is resolved by the Anthropic adapter.
 */
const MODEL_ALIASES = ["haiku", "sonnet", "opus"] as const;
export const ModelTarget = z
  .string()
  .min(1)
  .describe(
    "Model id: a Claude alias (haiku|sonnet|opus) or any concrete provider model id " +
      "(e.g. deepseek-chat, kimi-k2-0711-preview, deepseek/deepseek-chat, claude-sonnet-4-5).",
  );
export type ModelTarget = z.infer<typeof ModelTarget>;

/** The short Claude aliases the Anthropic adapter resolves to concrete ids. */
export const MODEL_ALIAS_VALUES: readonly string[] = MODEL_ALIASES;

/**
 * Sibling skill context — used when evaluating pack-sensitive criteria.
 */
export const SiblingSkillSchema = z.object({
  name: z.string().min(1).describe("Sibling skill name (kebab-case)"),
  description: z.string().min(1).describe("What the sibling does"),
  trigger_patterns: z
    .array(z.string())
    .optional()
    .describe("Prompts that should trigger the sibling instead"),
});

export type SiblingSkill = z.infer<typeof SiblingSkillSchema>;

/**
 * The eval spec is the machine-readable evaluation definition.
 *
 * It defines what criteria to check, what test cases to run,
 * which models to test, and what sibling context exists.
 */
export const EvalSpecSchema = z
  .object({
    spec_version: z.literal("1.0").describe("Schema version for forward compatibility"),
    skill_name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, "Must be kebab-case")
      .describe("Name of the skill being evaluated"),
    description: z.string().min(1).describe("What this eval spec covers"),
    criteria: z.array(CriterionSchema).min(1).describe("Binary criteria to evaluate"),
    self_test: SelfTestSchema.optional().describe(
      "Optional deterministic self-test: run the skill's own script (opt-in, via " +
        "`--run-self-test`) and fold its exit-code verdict in as a binary criterion.",
    ),
    test_cases: z.array(TestCaseSchema).min(1).describe("Test cases to run"),
    models: z.array(ModelTarget).default(["sonnet"]).describe("Models to test independently"),
    siblings: z
      .array(SiblingSkillSchema)
      .optional()
      .describe("Sibling skills for pack-sensitive evaluation"),
    tags: z.array(z.string()).optional().describe("Categorization tags"),
  })
  // Cross-validate the scoping link: every id a test case names in
  // `criteria_ids` must reference a real criterion. A renamed or misspelled id
  // would otherwise scope that test case to fewer criteria than intended — a
  // silent test gap. Caught here at spec-load, it surfaces in `j-rig validate`
  // with a precise path BEFORE any model spend (mirrors the deterministic_check
  // load-time validation; `selectCriteriaForTestCase` keeps the same guard at
  // runtime as defense-in-depth).
  .superRefine((spec, ctx) => {
    // `self-test` is a reserved criterion id: when a spec declares `self_test`,
    // j-rig injects a synthetic criterion under this id to score the script's
    // exit-code verdict. A user criterion sharing the id would collide with it.
    spec.criteria.forEach((c, ci) => {
      if (c.id === SELF_TEST_CRITERION_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `criterion id "${SELF_TEST_CRITERION_ID}" is reserved for the self_test verdict`,
          path: ["criteria", ci, "id"],
        });
      }
    });

    const knownCriteria = new Set(spec.criteria.map((c) => c.id));
    spec.test_cases.forEach((tc, ti) => {
      tc.criteria_ids?.forEach((cid, ci) => {
        if (!knownCriteria.has(cid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `test case "${tc.id}" references unknown criterion id "${cid}"`,
            path: ["test_cases", ti, "criteria_ids", ci],
          });
        }
      });
    });
  });

export type EvalSpec = z.infer<typeof EvalSpecSchema>;
