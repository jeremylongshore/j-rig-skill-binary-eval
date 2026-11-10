import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CostEventSchema,
  CostPolicySchema,
  costStopMicros,
  hashValue,
  replayCostLedger,
  reserveCost,
  type CostEvent,
  type CostLedgerState,
  type CostPolicy,
} from "@intentsolutions/refiner-core";

type ReservationInput = Omit<
  Extract<CostEvent, { kind: "reserve" }>,
  "kind" | "callId" | "reservedMicros"
>;
type SettlementInput = Omit<Extract<CostEvent, { kind: "settle" }>, "kind">;
type OutcomeInput = Omit<Extract<CostEvent, { kind: "outcome" }>, "kind">;
/** Shared, synchronous admission boundary. Lock contention and damaged logs fail closed.
 * A crashed writer's lock must be investigated, never automatically expired.
 */
export class CostLedger {
  readonly path: string;
  readonly #policy: CostPolicy;
  constructor(path: string, policy: CostPolicy) {
    this.path = resolve(path);
    this.#policy = CostPolicySchema.parse(policy);
    this.#transaction(() => undefined);
  }
  #transaction<T>(operation: (events: CostEvent[], state: CostLedgerState) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    try {
      if (!existsSync(this.path)) {
        const event: CostEvent = { kind: "policy", policy: this.#policy };
        const fd = openSync(
          this.path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(fd, this.#line(event, null));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const dir = openSync(dirname(this.path), constants.O_RDONLY);
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
      const fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        const text = readFileSync(fd, "utf8");
        if (!text.endsWith("\n")) throw new Error("Truncated cost ledger");
        let previous: string | null = null;
        const events: CostEvent[] = [];
        for (const line of text.trimEnd().split("\n")) {
          const row: unknown = JSON.parse(line);
          if (
            !row ||
            typeof row !== "object" ||
            !("event" in row) ||
            !("previous" in row) ||
            !("hash" in row) ||
            Object.keys(row).length !== 3 ||
            row.previous !== previous ||
            row.hash !== hashValue({ previous, event: row.event })
          )
            throw new Error("Corrupt cost ledger chain");
          events.push(CostEventSchema.parse(row.event));
          previous = row.hash as string;
        }
        const state = replayCostLedger(events);
        if (hashValue(state.policy) !== hashValue(this.#policy))
          throw new Error("Cost policy changed");
        const count = events.length;
        const result = operation(events, state);
        replayCostLedger(events);
        for (const event of events.slice(count)) {
          const line = this.#line(event, previous);
          writeFileSync(fd, line);
          fsyncSync(fd);
          previous = hashValue({ previous, event });
        }
        return result;
      } finally {
        closeSync(fd);
      }
    } finally {
      rmdirSync(lock);
    }
  }
  #line(event: CostEvent, previous: string | null): string {
    return `${JSON.stringify({ previous, event, hash: hashValue({ previous, event }) })}\n`;
  }
  snapshot(): CostLedgerState {
    return this.#transaction((_events, state) => state);
  }
  reserve(input: ReservationInput): string {
    const result = this.#transaction((events, state) => {
      const rate = state.policy.rates.find(
        (r) => r.provider === input.provider && r.model === input.model,
      );
      const file = Object.hasOwn(state.files, input.fileId) ? state.files[input.fileId] : undefined;
      if (!rate || !file) throw new Error("Missing explicit cost rate or file identity");
      const quote = reserveCost(rate, input.outputLimit);
      const wave =
        state.stopped ||
        BigInt(state.total.committedMicros) + BigInt(quote) > BigInt(costStopMicros(state.policy));
      const denied =
        wave ||
        file.quarantined ||
        BigInt(file.committedMicros) + BigInt(quote) > BigInt(state.policy.maxFileMicros);
      if (denied) {
        events.push({
          kind: "halt",
          fileId: input.fileId,
          scope: wave ? "wave" : "file",
          reason: wave ? "wave-stop" : "file-limit",
        });
        return null;
      }
      const callId = randomUUID();
      events.push(
        CostEventSchema.parse({ ...input, kind: "reserve", callId, reservedMicros: quote }),
      );
      return callId;
    });
    if (result === null) throw new Error("Cost admission stopped; manual review required");
    return result;
  }
  settle(input: SettlementInput): void {
    this.#transaction((events) => {
      events.push(CostEventSchema.parse({ ...input, kind: "settle" }));
    });
  }
  outcome(input: OutcomeInput): void {
    this.#transaction((events) => {
      events.push(CostEventSchema.parse({ ...input, kind: "outcome" }));
    });
  }
}
