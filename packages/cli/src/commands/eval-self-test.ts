import {
  runSelfTest,
  toSelfTestJudgment,
  buildSelfTestCriterion,
  type JudgmentResult,
  type Criterion,
} from "@j-rig/core";
import { icon } from "../lib/output.js";

/** Run the declared self-test once before model evaluation, only when opted in. */
export function evaluateDeclaredSelfTest(
  selfTest: Parameters<typeof runSelfTest>[0] | undefined,
  absDir: string,
  opts: { runSelfTest?: boolean; json?: boolean },
): { selfTestJudgment: JudgmentResult | undefined; selfTestCriterion: Criterion | undefined } {
  let selfTestJudgment: JudgmentResult | undefined;
  let selfTestCriterion: Criterion | undefined;
  if (selfTest) {
    if (opts.runSelfTest) {
      const st = runSelfTest(selfTest, absDir);
      selfTestJudgment = toSelfTestJudgment(st);
      selfTestCriterion = buildSelfTestCriterion(selfTest);
      if (!opts.json) {
        const mark = st.passed ? icon("pass") : icon("error");
        console.log(
          `  Self-test: ${mark} ${selfTestJudgment.reasoning}` +
            (selfTestCriterion.blocker ? " (blocker)" : ""),
        );
      }
    } else if (!opts.json) {
      console.log(
        "  Self-test: skill declares a self_test; re-run with --run-self-test to " +
          "execute it as a deterministic criterion.",
      );
    }
  }

  return { selfTestJudgment, selfTestCriterion };
}
