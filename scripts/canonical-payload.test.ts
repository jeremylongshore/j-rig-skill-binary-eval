import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceBundlePayloadSchema } from "@intentsolutions/core/validators/v1/evidence-statement";
import * as release from "./emit-evidence.ts";
import { assemble as assembleRelease } from "./assemble-manifest.ts";
import * as nightly from "../ci/emit-evidence/emit-evidence.ts";
import { assemble as assembleNightly } from "../ci/emit-evidence/assemble-manifest.ts";

const context = {
  nowIso: "2026-10-12T00:00:00.000Z",
  nowMs: 1791763200000,
  commitSha: "a".repeat(40),
  sourceSha: "a".repeat(40),
  policyHash: `sha256:${"b".repeat(64)}`,
  runnerVersion: "0.1.0",
  // Deliberately deterministic unsigned vector; kernel permits equal UUIDs.
  rand16: () => new Uint8Array(16),
};
const outcomes = (["pass", "fail", "advisory", "error"] as const).map((decision) => ({
  gateName: `synthetic-${decision}`,
  gateVersion: "1.0.0",
  decision,
  reasons: ["synthetic contract fixture; no live gate measurement"],
  dimensionsEvaluated: decision === "error" ? [] : ["provenance-integrity"],
  dimensionsSkipped: decision === "error" ? ["provenance-integrity"] : [],
  specSha256: "b".repeat(64),
  skillPath: "synthetic/skill",
  skillsCommit: "c".repeat(40),
  ...(decision === "advisory" ? { advisorySeverity: "warn" as const } : {}),
  ...(decision === "fail" || decision === "error" ? { failureMode: "fixture-error" } : {}),
}));
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

for (const { key, emitter, assemble, ref, workflow, makeEmission } of [
  {
    key: "iaj",
    emitter: release,
    assemble: assembleRelease,
    ref: "refs/tags/v2.1.0",
    workflow: "release.yml",
    makeEmission: (dir: string, ref: string) => {
      const rows = release.buildRows(outcomes, context);
      return { rows, skeleton: release.writeEmit(rows, ref, dir) };
    },
  },
  {
    key: "jrig",
    emitter: nightly,
    assemble: assembleNightly,
    ref: "refs/heads/main",
    workflow: "nightly-skill-evals.yml",
    makeEmission: (dir: string, ref: string) => {
      const rows = nightly.buildRows(outcomes, context);
      return { rows, skeleton: nightly.writeEmit(rows, ref, dir) };
    },
  },
]) {
  describe(`${key} canonical dashboard payload`, () => {
    function emitted() {
      const dir = mkdtempSync(join(tmpdir(), `${key}-canonical-payload-`));
      directories.push(dir);
      const { rows, skeleton } = makeEmission(dir, ref);
      for (let i = 0; i < rows.length; i++) {
        // Transport fixture only; CI/ingest verify real signatures separately.
        writeFileSync(join(dir, `bundle-${i}.sigstore.json`), "{}");
      }
      return { dir, rows, skeleton };
    }

    it("matches the shared kernel 0.10.0/0.11.0 vector and canonical bundle bytes", () => {
      const fixture = JSON.parse(
        readFileSync(new URL("./canonical-payload.fixture.json", import.meta.url), "utf8"),
      );
      const bundle = emitter.buildEvidenceBundle(fixture.row.evidencePayload, context);
      expect(bundle).toEqual(fixture.row.bundle);
      expect(emitter.stableStringify(bundle)).toBe(fixture.row.canonicalBundle);
    });

    it("preserves decisions, source identity and canonical payload artifacts", () => {
      const { dir, rows } = emitted();
      const manifest = assemble(dir);
      expect(manifest.repo).toBe(key);
      expect(manifest.rows).toHaveLength(outcomes.length);
      expect(manifest.signing.subject).toBe(
        `repo:jeremylongshore/j-rig-skill-binary-eval:ref:${ref}`,
      );
      expect(manifest.signing.workflowRef).toBe(
        `jeremylongshore/j-rig-skill-binary-eval/.github/workflows/${workflow}@${ref}`,
      );
      for (const [i, row] of rows.entries()) {
        const bytes = readFileSync(join(dir, `evidence-payload-${i}.json`), "utf8");
        expect(EvidenceBundlePayloadSchema.parse(JSON.parse(bytes))).toEqual(row.evidencePayload);
        expect(bytes).toBe(emitter.stableStringify(row.evidencePayload));
        const statement = row.evidencePayload[0]!;
        expect(statement.predicate).toEqual(row.gateResult);
        expect(statement.predicate.gate_decision).toBe(outcomes[i]!.decision);
        expect(statement.predicate.commit_sha).toBe(
          key === "iaj" ? context.commitSha : outcomes[i]!.skillsCommit,
        );
        expect(statement.subject[0]!.name).toBe(`${key}:ci:${outcomes[i]!.gateName}`);
        expect(row.bundle).toHaveProperty(
          "storage_key",
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        );
        expect(row.bundle).not.toHaveProperty(
          "storage_key",
          `sha256:${createHash("sha256").update(emitter.stableStringify(row.gateResult)).digest("hex")}`,
        );
        expect(manifest.rows[i]).toEqual({
          bundle: row.bundle,
          sigstoreBundle: {},
          sourceSha: context.sourceSha,
          evidencePayload: row.evidencePayload,
          gateResults: [row.gateResult],
        });
      }
    });

    for (const [field, mutation] of Object.entries({
      storage_key: `sha256:${"f".repeat(64)}`,
      row_count: 2,
      subject_set: [],
      predicate_uri_set: [],
    })) {
      it(`rejects changed signed ${field}`, () => {
        const { dir, rows } = emitted();
        writeFileSync(
          join(dir, "bundle-0.json"),
          emitter.stableStringify({
            ...(rows[0]!.bundle as Record<string, unknown>),
            [field]: mutation,
          }),
        );
        expect(() => assemble(dir)).toThrow(`signed bundle ${field}`);
      });
    }

    for (const variant of [
      "payload",
      "body",
      "missing-payload",
      "subject-name",
      "subject-digest",
    ] as const) {
      it(`rejects ${variant} mutation without legacy fallback`, () => {
        const { dir, skeleton } = emitted();
        const row = skeleton.rows[0]!;
        const statement = row.evidencePayload[0]!;
        const subject = statement.subject[0]!;
        const mutations = {
          payload: { evidencePayload: [{ ...statement, extensions: { tampered: true } }] },
          body: {
            gateResults: [
              { ...(row.gateResults[0] as Record<string, unknown>), gate_reasons: ["tampered"] },
            ],
          },
          "missing-payload": { evidencePayload: undefined },
          "subject-name": {
            evidencePayload: [{ ...statement, subject: [{ ...subject, name: "wrong" }] }],
          },
          "subject-digest": {
            evidencePayload: [
              { ...statement, subject: [{ ...subject, digest: { sha256: "f".repeat(64) } }] },
            ],
          },
        };
        const expected = {
          payload: /signed bundle storage_key/,
          body: /gateResults do not match evidencePayload predicates/,
          "missing-payload": /expected array, received undefined/,
          "subject-name": /subject\[0\]\.name must equal predicate\.gate_id/,
          "subject-digest": /subject\[0\]\.digest\.sha256/,
        };
        writeFileSync(
          join(dir, "manifest-skeleton.json"),
          JSON.stringify({
            ...skeleton,
            rows: [{ ...row, ...mutations[variant] }, ...skeleton.rows.slice(1)],
          }),
        );
        expect(() => assemble(dir)).toThrow(expected[variant]);
      });
    }

    it("fails closed when the signature file is missing", () => {
      const { dir } = emitted();
      rmSync(join(dir, "bundle-0.sigstore.json"));
      expect(() => assemble(dir)).toThrow(/missing sigstore bundle/);
    });
  });
}
