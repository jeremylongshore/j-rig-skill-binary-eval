import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildVoteEvidence, type VoteEvidenceInput } from "./eval-vote-evidence.js";

// Captured from the original inline block at 9f0275a, before extraction.
// Exact JSON bytes cover field presence/order as well as values.
const fixtures = [
  {
    name: "empty inventory retains aggregation defaults",
    input: {
      allJudgments: [],
      scoringCriteria: [],
      spec: {},
      scoreCard: {},
    },
    expected:
      '{"aggregation":{"rule":"majority-vote","denominator_rule":"errored-samples-count-as-unsure","blocker_quorum":null,"samples_default":1},"criteria":[]}',
    sha256: "36f3eb179899612eca23f634bbe8492b056f415f697d43ec8f3d0f8427f64bbb",
  },
  {
    name: "legacy single result omits absent sample and stability fields",
    input: {
      allJudgments: [
        {
          criterion_id: "criterion-a",
          verdict: "yes",
          confidence: 1,
          reasoning: "observed",
          method: "deterministic",
        },
      ],
      scoringCriteria: [
        {
          id: "criterion-a",
          blocker: true,
        },
      ],
      spec: {},
      scoreCard: {},
    },
    expected:
      '{"aggregation":{"rule":"majority-vote","denominator_rule":"errored-samples-count-as-unsure","blocker_quorum":null,"samples_default":1},"criteria":[{"criterion_id":"criterion-a","blocker":true,"method":"deterministic","verdict":"yes"}]}',
    sha256: "95cba6c8925fbd368e90c69fe6511d0a2e7c41a17686cb25466cc1f26ef6a964",
  },
  {
    name: "explicit zero and empty fields survive without fabricated stability",
    input: {
      allJudgments: [
        {
          criterion_id: "criterion-a",
          verdict: "yes",
          confidence: 1,
          reasoning: "observed",
          method: "deterministic",
          test_case_id: "",
          samples: 0,
          agreement: 0,
          sample_verdicts: [],
          sample_latencies_ms: [],
        },
      ],
      scoringCriteria: [],
      spec: {
        min_blocker_agreement: 0,
      },
      judgeSamples: 0,
      scoreCard: {
        unstable_blocker_failures: 0,
      },
    },
    expected:
      '{"aggregation":{"rule":"majority-vote","denominator_rule":"errored-samples-count-as-unsure","blocker_quorum":0,"samples_default":0},"criteria":[{"criterion_id":"criterion-a","test_case_id":"","blocker":false,"method":"deterministic","verdict":"yes","samples":0,"agreement":0,"sample_verdicts":[],"sample_latencies_ms":[]}]}',
    sha256: "5ce745a707c4841196455e5810025d11217d8684316d50f7d46f82278a3fe5b7",
  },
  {
    name: "multi-sample preserves order, duplicate last criterion and aligned timings",
    input: {
      allJudgments: [
        {
          criterion_id: "criterion-a",
          verdict: "yes",
          confidence: 1,
          reasoning: "observed",
          method: "judge",
          samples: 3,
          agreement: 0.6666666666666666,
          sample_verdicts: ["no", "yes", "yes"],
          sample_latencies_ms: [30, 10, 20],
          test_case_id: "case-b",
        },
        {
          criterion_id: "unknown",
          verdict: "unsure",
          confidence: 1,
          reasoning: "observed",
          method: "deterministic",
        },
        {
          criterion_id: "criterion-a",
          verdict: "yes",
          confidence: 1,
          reasoning: "observed",
          method: "deterministic",
          test_case_id: "case-a",
          samples: 1,
        },
      ],
      scoringCriteria: [
        {
          id: "criterion-a",
          blocker: false,
        },
        {
          id: "criterion-a",
          blocker: true,
        },
      ],
      spec: {
        min_blocker_agreement: 0.8,
      },
      judgeSamples: 5,
      scoreCard: {
        unstable_blocker_failures: 2,
      },
    },
    expected:
      '{"aggregation":{"rule":"majority-vote","denominator_rule":"errored-samples-count-as-unsure","blocker_quorum":0.8,"samples_default":5},"criteria":[{"criterion_id":"criterion-a","test_case_id":"case-b","blocker":true,"method":"judge","verdict":"yes","samples":3,"agreement":0.6666666666666666,"sample_verdicts":["no","yes","yes"],"sample_latencies_ms":[30,10,20]},{"criterion_id":"unknown","blocker":false,"method":"deterministic","verdict":"unsure"},{"criterion_id":"criterion-a","test_case_id":"case-a","blocker":true,"method":"deterministic","verdict":"yes","samples":1}],"stability":{"min_blocker_agreement":0.8,"unstable_blocker_failures":2}}',
    sha256: "078570cf929debad3566e49d747da1f5e62620914982a352938d26785cb81e53",
  },
  {
    name: "multi-sample missing quorum and failure count use null and zero",
    input: {
      allJudgments: [
        {
          criterion_id: "criterion-a",
          verdict: "yes",
          confidence: 1,
          reasoning: "observed",
          method: "deterministic",
          samples: 2,
        },
      ],
      scoringCriteria: [],
      spec: {},
      scoreCard: {},
    },
    expected:
      '{"aggregation":{"rule":"majority-vote","denominator_rule":"errored-samples-count-as-unsure","blocker_quorum":null,"samples_default":1},"criteria":[{"criterion_id":"criterion-a","blocker":false,"method":"deterministic","verdict":"yes","samples":2}],"stability":{"min_blocker_agreement":null,"unstable_blocker_failures":0}}',
    sha256: "5c8768b94173dd009b041b073e0a605507896dc5d73e525c4eb58df209c33adc",
  },
];

describe("vote evidence serialization", () => {
  it.each(fixtures)("$name", ({ input, expected, sha256 }) => {
    const before = JSON.stringify(input);
    const result = buildVoteEvidence({ judgeSamples: undefined, ...input } as VoteEvidenceInput);
    const serialized = JSON.stringify(result);
    expect(serialized).toBe(expected);
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(sha256);
    expect(JSON.stringify(input)).toBe(before);
  });
});
