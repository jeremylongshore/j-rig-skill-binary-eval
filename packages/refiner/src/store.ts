/**
 * Refiner persistence — content-addressed store + append-only event log +
 * single mutable best-pointer (plan 027 § 4 Phase A build-order step 4).
 *
 * This is the I/O half of the value-oriented discipline whose PURE half lives in
 * `@j-rig/refiner-core`. The core produces immutable value objects (SkillDoc,
 * EditProposal, ScoreRecord, EvalSet); this module persists each one under its
 * content address so the same value is written at most once and can never be
 * silently mutated in place (AC-2, Hickey-aligned).
 *
 * On-disk layout (rooted at `<root>/.j-rig/refiner/`):
 *
 *   store/<hash>            — one immutable value per content address (JSON).
 *   log.jsonl              — append-only event log; one JSON value per line.
 *   pointers/<skill>/best  — a single mutable file holding ONE hash (the
 *                            current best SkillVersion for that skill).
 *
 * The store is keyed by `@j-rig/refiner-core`'s `hashValue` (canonical-JSON
 * SHA-256), so two structurally-equal values collapse to one object. The event
 * log is the audit trail — every persisted value and every pointer move appends
 * a typed event, so the whole refiner history is replayable from `log.jsonl`.
 *
 * Filesystem access is injected via the {@link FileSystem} seam so the store is
 * unit-testable against an in-memory fake — no real disk, no temp dirs.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { hashValue } from "@j-rig/refiner-core";
import type { SkillDoc, EditProposal, ScoreRecord, EvalSet } from "@j-rig/refiner-core";

/**
 * Minimal filesystem seam the store needs. The default implementation wraps
 * `node:fs`; tests pass an in-memory fake. Paths are POSIX-style and joined by
 * the store with `/` so the fake never needs a path module.
 */
export interface FileSystem {
  readFile(path: string): string | null;
  writeFile(path: string, data: string): void;
  appendFile(path: string, data: string): void;
  mkdirp(path: string): void;
  exists(path: string): boolean;
}

/** The kind of value an entry in the store / event log carries. */
export type RefinerRecordKind = "skill-doc" | "edit-proposal" | "score-record" | "eval-set";

/** A single line in the append-only event log. */
export type RefinerEvent =
  | {
      readonly type: "stored";
      readonly kind: RefinerRecordKind;
      readonly hash: string;
      readonly at: string;
    }
  | {
      readonly type: "best-pointer-moved";
      readonly skillId: string;
      readonly from: string | null;
      readonly to: string;
      readonly at: string;
    };

const REFINER_DIR = ".j-rig/refiner";

/**
 * The content-addressed store. Stateless apart from the injected filesystem +
 * root; all addressing is derived from value content, so two RefinerStore
 * instances over the same root see the same objects.
 */
export class RefinerStore {
  readonly #fs: FileSystem;
  readonly #root: string;
  readonly #clock: () => string;

  /**
   * @param fs    Filesystem seam (defaults to a `node:fs`-backed impl).
   * @param root  Project root; the store lives at `<root>/.j-rig/refiner/`.
   * @param clock Injected wall-clock returning rfc3339 (for deterministic tests).
   */
  constructor(opts: { fs?: FileSystem; root?: string; clock?: () => string } = {}) {
    this.#fs = opts.fs ?? createNodeFileSystem();
    this.#root = opts.root ?? ".";
    this.#clock = opts.clock ?? (() => new Date().toISOString());
  }

  // ── paths ────────────────────────────────────────────────────────────────

  #base(): string {
    return join(this.#root, REFINER_DIR);
  }
  #storePath(hash: string): string {
    return join(this.#base(), "store", hash);
  }
  #logPath(): string {
    return join(this.#base(), "log.jsonl");
  }
  #pointerPath(skillId: string): string {
    return join(this.#base(), "pointers", skillId, "best");
  }

  // ── content-addressed put / get ────────────────────────────────────────────

  /**
   * Persist a value under its content address. Idempotent: writing the same value
   * twice is a no-op for the object file (content addressing) and appends NO new
   * `stored` event the second time, so the log stays a faithful first-write trail.
   * Returns the content address.
   *
   * NOTE on the two hashes a SkillDoc carries: the STORE ADDRESS is `hashValue`
   * over the whole value object (`{skillId, text, hash}`), whereas a SkillDoc's
   * own `.hash` field is `hashSkillDoc(text)` (text only). They differ by design —
   * the store address keys the store; the `.hash` field is what `applyEdit`
   * matches a proposal's `parent` against. Use the store address with
   * `get`/`has`/`setBest`; use `doc.hash` when building an EditProposal.
   */
  put(kind: RefinerRecordKind, value: unknown): string {
    const hash = hashValue(value);
    const path = this.#storePath(hash);
    if (this.#fs.exists(path)) return hash; // already stored — no duplicate event
    this.#fs.mkdirp(dirname(path));
    this.#fs.writeFile(path, JSON.stringify(value));
    this.#appendEvent({ type: "stored", kind, hash, at: this.#clock() });
    return hash;
  }

  /** Read a value back by content address, or null if it was never stored. */
  get<T = unknown>(hash: string): T | null {
    const raw = this.#fs.readFile(this.#storePath(hash));
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  /** True if a value with this content address has been stored. */
  has(hash: string): boolean {
    return this.#fs.exists(this.#storePath(hash));
  }

  // ── typed convenience puts (value-kind round-trips) ────────────────────────

  putSkillDoc(doc: SkillDoc): string {
    return this.put("skill-doc", doc);
  }
  putEditProposal(proposal: EditProposal): string {
    return this.put("edit-proposal", proposal);
  }
  putScoreRecord(score: ScoreRecord): string {
    return this.put("score-record", score);
  }
  putEvalSet(evalSet: EvalSet): string {
    return this.put("eval-set", evalSet);
  }

  // ── best-pointer (the single mutable cell) ─────────────────────────────────

  /** Read the current best SkillVersion hash for a skill, or null if unset. */
  getBest(skillId: string): string | null {
    const raw = this.#fs.readFile(this.#pointerPath(skillId));
    return raw === null ? null : raw.trim() || null;
  }

  /**
   * Move the best-pointer to a new hash and log the move. The value MUST already
   * be in the store (you cannot point `best` at an object that was never
   * persisted) — this keeps the pointer an index into immutable history, never a
   * dangling reference.
   *
   * @throws if `hash` is not present in the store.
   */
  setBest(skillId: string, hash: string): void {
    if (!this.has(hash)) {
      throw new Error(`refiner store: cannot set best to un-stored hash ${hash.slice(0, 8)}`);
    }
    const from = this.getBest(skillId);
    const path = this.#pointerPath(skillId);
    this.#fs.mkdirp(dirname(path));
    this.#fs.writeFile(path, hash);
    this.#appendEvent({ type: "best-pointer-moved", skillId, from, to: hash, at: this.#clock() });
  }

  // ── event log ──────────────────────────────────────────────────────────────

  /** Read the full append-only event log in order. Empty if none yet. */
  readLog(): RefinerEvent[] {
    const raw = this.#fs.readFile(this.#logPath());
    if (raw === null) return [];
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RefinerEvent);
  }

  #appendEvent(event: RefinerEvent): void {
    this.#fs.mkdirp(this.#base());
    this.#fs.appendFile(this.#logPath(), JSON.stringify(event) + "\n");
  }
}

// ── path helpers (POSIX, no node:path dep so the fake fs stays trivial) ───────

function join(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "." : path.slice(0, idx);
}

// ── default node:fs-backed implementation ─────────────────────────────────────

/**
 * A real {@link FileSystem} over `node:fs`. Imported lazily so a consumer that
 * only ever injects a fake never pulls `node:fs` into a non-Node bundle.
 */
export function createNodeFileSystem(): FileSystem {
  return {
    readFile(path: string): string | null {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile(path: string, data: string): void {
      writeFileSync(path, data, "utf8");
    },
    appendFile(path: string, data: string): void {
      appendFileSync(path, data, "utf8");
    },
    mkdirp(path: string): void {
      mkdirSync(path, { recursive: true });
    },
    exists(path: string): boolean {
      return existsSync(path);
    },
  };
}
