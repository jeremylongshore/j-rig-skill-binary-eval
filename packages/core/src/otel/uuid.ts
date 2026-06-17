/**
 * RFC 9562 UUIDv7 generator.
 *
 * The 067 taxonomy (§ 4.2) + the kernel YAML pin `eval.run_id` as a UUIDv7 —
 * a time-ordered UUID whose first 48 bits are a Unix-epoch millisecond
 * timestamp, so EvalRun ids sort chronologically and double as the idempotency
 * key. Node's `crypto.randomUUID()` only produces UUIDv4 (no time ordering),
 * so we mint v7 ourselves from `crypto.randomBytes`. No external dependency —
 * `@j-rig/core` keeps its dependency surface tight (kernel discipline).
 *
 * Layout (RFC 9562 § 5.7):
 *   - bits  0..47  : unix_ts_ms (big-endian millisecond timestamp)
 *   - bits 48..51  : version (0b0111 = 7)
 *   - bits 52..63  : rand_a (12 random bits)
 *   - bits 64..65  : variant (0b10)
 *   - bits 66..127 : rand_b (62 random bits)
 */

import { randomBytes } from "node:crypto";

/**
 * Generate a fresh RFC 9562 UUIDv7 string (canonical 8-4-4-4-12 hyphenated
 * lowercase form).
 *
 * @param nowMs Override the timestamp (testing only — lets a test assert the
 *              time-ordering / version+variant bits deterministically).
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit timestamp (big-endian) into bytes 0..5.
  const ts = Math.max(0, Math.floor(nowMs));
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  // Version 7: high nibble of byte 6 = 0b0111. Low nibble stays random (rand_a).
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Variant 0b10: high two bits of byte 8. Remaining bits stay random (rand_b).
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}
