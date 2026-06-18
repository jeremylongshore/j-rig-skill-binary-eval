import { describe, it, expect, beforeEach } from "vitest";
import { makeSkillDoc, bootstrap } from "@j-rig/refiner-core";
import type { ScoreRecord, EditProposal } from "@j-rig/refiner-core";
import { RefinerStore, type FileSystem, type RefinerEvent } from "./store.js";

/** In-memory FileSystem fake — no real disk, deterministic, POSIX paths. */
class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, string>();

  readFile(path: string): string | null {
    return this.files.has(path) ? this.files.get(path)! : null;
  }
  writeFile(path: string, data: string): void {
    this.files.set(path, data);
  }
  appendFile(path: string, data: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + data);
  }
  mkdirp(): void {
    // no-op for the flat map; dirs are implicit
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
}

const FIXED_CLOCK = () => "2026-06-17T00:00:00.000Z";

function makeStore(): { store: RefinerStore; fs: MemoryFileSystem } {
  const fs = new MemoryFileSystem();
  const store = new RefinerStore({ fs, root: "/proj", clock: FIXED_CLOCK });
  return { store, fs };
}

describe("RefinerStore — content-addressed store (build-order step 4)", () => {
  let store: RefinerStore;

  beforeEach(() => {
    ({ store } = makeStore());
  });

  it("round-trips a SkillDoc by content address", () => {
    const doc = makeSkillDoc("demo", "# Demo\n\nProcedural instruction line here.\n");
    const hash = store.putSkillDoc(doc);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.has(hash)).toBe(true);
    expect(store.get(hash)).toEqual(doc);
  });

  it("is content-addressed: equal values collapse to one object + one stored event", () => {
    const a = makeSkillDoc("demo", "same text body for the skill doc value");
    const b = makeSkillDoc("demo", "same text body for the skill doc value");
    const hashA = store.putSkillDoc(a);
    const hashB = store.putSkillDoc(b);
    expect(hashA).toBe(hashB); // determinism: identical content → identical address
    const stored = store.readLog().filter((e) => e.type === "stored");
    expect(stored).toHaveLength(1); // idempotent: second put appends no new event
  });

  it("addresses different values differently", () => {
    const a = makeSkillDoc("demo", "first version");
    const b = makeSkillDoc("demo", "second version");
    expect(store.putSkillDoc(a)).not.toBe(store.putSkillDoc(b));
  });

  it("returns null for an un-stored hash", () => {
    expect(store.get("deadbeef".repeat(8))).toBeNull();
    expect(store.has("deadbeef".repeat(8))).toBe(false);
  });

  it("persists each refiner value kind", () => {
    const doc = makeSkillDoc("demo", "skill body line one and two");
    const evalSet = bootstrap(doc, { now: "2026-06-17T00:00:00.000Z" });
    const proposal: EditProposal = {
      parent: doc.hash,
      ops: [{ kind: "add", after: "skill body", content: " extended" }],
      refinerModel: "claude-sonnet-4-5",
      refinerStrategyId: "skill-opt-style/v1",
      rationale: "test",
    };
    const score: ScoreRecord = {
      skill: doc.hash,
      evalSet: evalSet.hash,
      behavioral: { value: 0.8, variance: 0.16, n: 5 },
      dimensions: { behavioral: { value: 0.8, variance: 0.16, n: 5 } },
    };
    const docHash = store.putSkillDoc(doc);
    const setHash = store.putEvalSet(evalSet);
    const propHash = store.putEditProposal(proposal);
    const scoreHash = store.putScoreRecord(score);
    expect(store.get(docHash)).toEqual(doc);
    expect(store.get(setHash)).toEqual(evalSet);
    expect(store.get(propHash)).toEqual(proposal);
    expect(store.get(scoreHash)).toEqual(score);
    const kinds = store.readLog().flatMap((e) => (e.type === "stored" ? [e.kind] : []));
    expect(kinds.sort()).toEqual(["edit-proposal", "eval-set", "score-record", "skill-doc"]);
  });
});

describe("RefinerStore — best-pointer (the single mutable cell)", () => {
  let store: RefinerStore;

  beforeEach(() => {
    ({ store } = makeStore());
  });

  it("starts unset and moves on setBest", () => {
    const doc = makeSkillDoc("demo", "version one body text");
    const hash = store.putSkillDoc(doc);
    expect(store.getBest("demo")).toBeNull();
    store.setBest("demo", hash);
    expect(store.getBest("demo")).toBe(hash);
  });

  it("refuses to point best at an un-stored hash", () => {
    expect(() => store.setBest("demo", "f".repeat(64))).toThrow(/un-stored hash/);
  });

  it("logs the pointer move with from/to", () => {
    const v1 = makeSkillDoc("demo", "version one body");
    const v2 = makeSkillDoc("demo", "version two body");
    const h1 = store.putSkillDoc(v1);
    const h2 = store.putSkillDoc(v2);
    store.setBest("demo", h1);
    store.setBest("demo", h2);
    const moves = store
      .readLog()
      .filter(
        (e): e is Extract<RefinerEvent, { type: "best-pointer-moved" }> =>
          e.type === "best-pointer-moved",
      );
    expect(moves).toHaveLength(2);
    expect(moves[0]).toMatchObject({ skillId: "demo", from: null, to: h1 });
    expect(moves[1]).toMatchObject({ skillId: "demo", from: h1, to: h2 });
  });
});

describe("RefinerStore — append-only event log", () => {
  it("reads back events in append order; empty when nothing written", () => {
    const { store } = makeStore();
    expect(store.readLog()).toEqual([]);
    const doc = makeSkillDoc("demo", "a sufficiently long body line");
    const hash = store.putSkillDoc(doc);
    store.setBest("demo", hash);
    const log = store.readLog();
    expect(log).toHaveLength(2);
    expect(log[0].type).toBe("stored");
    expect(log[1].type).toBe("best-pointer-moved");
    expect(log[0]).toMatchObject({ at: "2026-06-17T00:00:00.000Z" });
  });

  it("writes one JSONL line per event (newline-terminated)", () => {
    const { store, fs } = makeStore();
    const doc = makeSkillDoc("demo", "body text here for the doc");
    store.putSkillDoc(doc);
    const raw = fs.readFile("/proj/.j-rig/refiner/log.jsonl")!;
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trim().split("\n")).toHaveLength(1);
  });
});
