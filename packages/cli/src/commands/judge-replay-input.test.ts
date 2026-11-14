import { describe, expect, it } from "vitest";
import { admitReplay, replayDigest } from "./judge-replay-input.js";

function fixture() {
  const corpus = {
    schema: "j-rig/judge-replay-corpus/v1",
    source: { revision: "synthetic-offline-fixture", artifact_sha256: `sha256:${"a".repeat(64)}` },
    rows: [
      {
        id: "case-1",
        criterion: { id: "c1", description: "Contains the requested greeting" },
        prompt: "Say hello",
        output: " hello\n",
      },
    ],
  };
  const corpusBytes = JSON.stringify(corpus);
  const review = {
    schema: "j-rig/judge-replay-review/v1",
    corpus_sha256: replayDigest(corpusBytes),
    reviewer: "synthetic-test-reviewer",
    reviewed_at: "2026-01-01T00:00:00Z",
    reviewed: true,
    labels: [
      {
        id: "case-1",
        expected_verdict: "yes",
        rationale: "Synthetic fixture explicitly contains hello",
      },
    ],
  };
  const policy = {
    provider: "groq",
    model: "offline-fixture",
    samples: 5,
    repeats: 2,
    temperature: 0.7,
    requests_per_minute: 30,
    judge_timeout_ms: 100,
    max_wall_ms: 10000,
    max_calls: 10,
  };
  return { corpus, corpusBytes, review, policy, now: new Date("2026-02-01T00:00:00Z") };
}

describe("fixed-output replay admission (synthetic labels only)", () => {
  it("preserves exact prompt/output and binds input, review, policy and call count", () => {
    const f = fixture();
    const reviewBytes = JSON.stringify(f.review);
    const result = admitReplay(f.corpusBytes, reviewBytes, f.policy, f.now);
    expect(result.rows[0]!.golden.output).toBe(" hello\n");
    expect(result.rows[0]!.golden.prompt).toBe("Say hello");
    expect(result.corpusHash).toBe(replayDigest(f.corpusBytes));
    expect(result.reviewHash).toBe(replayDigest(reviewBytes));
    expect(result.plannedCalls).toBe(10);
    expect(result.pacing.minimum_start_interval_ms).toBe(2000);
    expect(result.rows[0]!.criterion.method).toBe("judge");
  });

  it("rejects duplicate JSON keys instead of accepting the final value", () => {
    const f = fixture();
    const bytes = f.corpusBytes.replace('"schema":', '"schema":"ignored","schema":');
    f.review.corpus_sha256 = replayDigest(bytes);
    expect(() => admitReplay(bytes, JSON.stringify(f.review), f.policy, f.now)).toThrow(
      "duplicate",
    );
  });

  it("rejects even whitespace-only changes after review", () => {
    const f = fixture();
    expect(() =>
      admitReplay(f.corpusBytes + "\n", JSON.stringify(f.review), f.policy, f.now),
    ).toThrow("bind corpus");
  });

  it.each(["missing", "duplicate", "foreign"])("rejects %s review labels", (kind) => {
    const f = fixture();
    if (kind === "missing") f.review.labels = [];
    if (kind === "duplicate") f.review.labels.push(f.review.labels[0]!);
    if (kind === "foreign") f.review.labels[0]!.id = "absent";
    expect(() => admitReplay(f.corpusBytes, JSON.stringify(f.review), f.policy, f.now)).toThrow();
  });

  it("rejects duplicate corpus rows even when review is bound to their bytes", () => {
    const f = fixture();
    f.corpus.rows.push(f.corpus.rows[0]!);
    const bytes = JSON.stringify(f.corpus);
    f.review.corpus_sha256 = replayDigest(bytes);
    expect(() => admitReplay(bytes, JSON.stringify(f.review), f.policy, f.now)).toThrow(
      "Duplicate",
    );
  });

  it("rejects unreviewed and future-dated attestations", () => {
    const f = fixture();
    expect(() =>
      admitReplay(f.corpusBytes, JSON.stringify({ ...f.review, reviewed: false }), f.policy, f.now),
    ).toThrow();
    expect(() =>
      admitReplay(f.corpusBytes, JSON.stringify(f.review), f.policy, new Date("2025-01-01")),
    ).toThrow("future");
  });

  it("refuses insufficient call budgets and missing explicit bounds", () => {
    const f = fixture();
    expect(() =>
      admitReplay(f.corpusBytes, JSON.stringify(f.review), { ...f.policy, max_calls: 9 }, f.now),
    ).toThrow("call limit");
    expect(() =>
      admitReplay(
        f.corpusBytes,
        JSON.stringify(f.review),
        { ...f.policy, max_wall_ms: undefined },
        f.now,
      ),
    ).toThrow();
  });

  it("bounds UTF-8 bytes and does not infer a passing label from output", () => {
    const f = fixture();
    f.review.labels[0]!.expected_verdict = "no";
    const result = admitReplay(f.corpusBytes, JSON.stringify(f.review), f.policy, f.now);
    expect(result.rows[0]!.golden.expected_verdict).toBe("no");
    expect(() =>
      admitReplay("😀".repeat(1_048_577), JSON.stringify(f.review), f.policy, f.now),
    ).toThrow("4 MiB");
  });
});
