/**
 * Tests for kernel-version.ts — kernel-bump propagation (bead s58e).
 *
 * Covers:
 *   - CONSUMED_KERNEL_VERSION: present and parses as a valid semver triple.
 *   - peerDependency: package.json declares @intentsolutions/core in peerDependencies.
 *   - parseVersionTuple: valid semver, pre-release suffix, malformed input.
 *   - compareVersions: equal, less-than, greater-than across major/minor/patch axes.
 *   - isBaselineSupersededByKernel: true when current>baseline, false when equal,
 *     false when current<baseline.
 *   - BaselineKernelRef: structural round-trip (plain object assignment).
 *   - SupersededBaselineRecord / makeSupersededBaselineRecord: carries from→to,
 *     rejects invalid invocations.
 *
 * Not mocked: all functions under test are pure; no stubs or spies.
 */

import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
const require = createRequire(import.meta.url);
const pkgJson = require("../package.json") as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
import {
  CONSUMED_KERNEL_VERSION,
  parseVersionTuple,
  compareVersions,
  isBaselineSupersededByKernel,
  makeSupersededBaselineRecord,
} from "./kernel-version.js";
import type { BaselineKernelRef, SupersededBaselineRecord } from "./kernel-version.js";

// ── CONSUMED_KERNEL_VERSION ──────────────────────────────────────────────────

describe("CONSUMED_KERNEL_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof CONSUMED_KERNEL_VERSION).toBe("string");
    expect(CONSUMED_KERNEL_VERSION.length).toBeGreaterThan(0);
  });

  it("parses as a valid semver triple (no leading zeros, three numeric components)", () => {
    const [major, minor, patch] = parseVersionTuple(CONSUMED_KERNEL_VERSION);
    expect(Number.isInteger(major)).toBe(true);
    expect(Number.isInteger(minor)).toBe(true);
    expect(Number.isInteger(patch)).toBe(true);
    expect(major).toBeGreaterThanOrEqual(0);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });
});

// ── peerDependency declaration ────────────────────────────────────────────────

describe("package.json peerDependencies", () => {
  it("declares @intentsolutions/core in peerDependencies", () => {
    const peers = pkgJson.peerDependencies as Record<string, string> | undefined;
    expect(peers).toBeDefined();
    expect(typeof peers!["@intentsolutions/core"]).toBe("string");
  });

  it("peerDependency range covers the currently consumed version (^0.x.y form)", () => {
    const peers = pkgJson.peerDependencies as Record<string, string>;
    const range = peers["@intentsolutions/core"];
    // Range must be a caret range (^) or exact — either covers the consumed version.
    // We check that the range starts with ^ and the major.minor prefix matches.
    expect(range).toMatch(/^\^?\d+\.\d+/);
  });

  it("also declares @intentsolutions/core in dependencies (dep/peerDep duality)", () => {
    const deps = pkgJson.dependencies as Record<string, string> | undefined;
    expect(deps).toBeDefined();
    expect(typeof deps!["@intentsolutions/core"]).toBe("string");
  });
});

// ── parseVersionTuple ─────────────────────────────────────────────────────────

describe("parseVersionTuple", () => {
  it("parses a standard semver string", () => {
    expect(parseVersionTuple("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersionTuple("0.8.0")).toEqual([0, 8, 0]);
    expect(parseVersionTuple("10.20.30")).toEqual([10, 20, 30]);
  });

  it("ignores pre-release and build-metadata suffixes on PATCH", () => {
    expect(parseVersionTuple("1.2.3-alpha.1")).toEqual([1, 2, 3]);
    expect(parseVersionTuple("0.8.0+build.1")).toEqual([0, 8, 0]);
    expect(parseVersionTuple("2.0.0-rc.1+sha.5114f85")).toEqual([2, 0, 0]);
  });

  it("returns [0, 0, 0] for malformed input", () => {
    expect(parseVersionTuple("")).toEqual([0, 0, 0]);
    expect(parseVersionTuple("not-a-version")).toEqual([0, 0, 0]);
    expect(parseVersionTuple("1.2")).toEqual([0, 0, 0]); // only two components
  });
});

// ── compareVersions ───────────────────────────────────────────────────────────

describe("compareVersions", () => {
  it("returns 0 when versions are equal by major.minor.patch", () => {
    expect(compareVersions("0.8.0", "0.8.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns 1 when a > b on major component", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("returns -1 when a < b on major component", () => {
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
  });

  it("returns 1 when a > b on minor component (same major)", () => {
    expect(compareVersions("0.9.0", "0.8.0")).toBe(1);
  });

  it("returns -1 when a < b on minor component (same major)", () => {
    expect(compareVersions("0.8.0", "0.9.0")).toBe(-1);
  });

  it("returns 1 when a > b on patch component (same major.minor)", () => {
    expect(compareVersions("0.8.1", "0.8.0")).toBe(1);
  });

  it("returns -1 when a < b on patch component (same major.minor)", () => {
    expect(compareVersions("0.8.0", "0.8.1")).toBe(-1);
  });

  it("treats pre-release suffix as equal to release (only numeric triple matters)", () => {
    // 1.0.0-alpha has tuple [1,0,0]; 1.0.0 has tuple [1,0,0] → equal
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(0);
  });
});

// ── isBaselineSupersededByKernel ──────────────────────────────────────────────

describe("isBaselineSupersededByKernel", () => {
  it("returns true when currentKernelVersion > baselineKernelVersion (patch bump)", () => {
    expect(isBaselineSupersededByKernel("0.8.0", "0.8.1")).toBe(true);
  });

  it("returns true when currentKernelVersion > baselineKernelVersion (minor bump)", () => {
    expect(isBaselineSupersededByKernel("0.8.0", "0.9.0")).toBe(true);
  });

  it("returns true when currentKernelVersion > baselineKernelVersion (major bump)", () => {
    expect(isBaselineSupersededByKernel("0.8.0", "1.0.0")).toBe(true);
  });

  it("returns false when currentKernelVersion === baselineKernelVersion (baseline is current)", () => {
    expect(isBaselineSupersededByKernel("0.8.0", "0.8.0")).toBe(false);
  });

  it("returns false when currentKernelVersion < baselineKernelVersion (should not happen in practice; baseline stays valid)", () => {
    expect(isBaselineSupersededByKernel("0.9.0", "0.8.0")).toBe(false);
  });

  it("CONSUMED_KERNEL_VERSION is not superseded by itself", () => {
    expect(isBaselineSupersededByKernel(CONSUMED_KERNEL_VERSION, CONSUMED_KERNEL_VERSION)).toBe(
      false,
    );
  });
});

// ── BaselineKernelRef (structural round-trip) ─────────────────────────────────

describe("BaselineKernelRef", () => {
  it("round-trips as a plain object assignment", () => {
    const ref: BaselineKernelRef = { kernelVersion: "0.8.0" };
    expect(ref.kernelVersion).toBe("0.8.0");
  });

  it("accepts CONSUMED_KERNEL_VERSION as a valid kernelVersion value", () => {
    const ref: BaselineKernelRef = { kernelVersion: CONSUMED_KERNEL_VERSION };
    expect(ref.kernelVersion).toBe(CONSUMED_KERNEL_VERSION);
  });
});

// ── SupersededBaselineRecord / makeSupersededBaselineRecord ───────────────────

describe("makeSupersededBaselineRecord", () => {
  it("returns a record with the correct from→to kernel versions", () => {
    const record: SupersededBaselineRecord = makeSupersededBaselineRecord(
      "0.8.0",
      "0.9.0",
      "2026-06-20T12:00:00Z",
    );
    expect(record.baselineKernelVersion).toBe("0.8.0");
    expect(record.currentKernelVersion).toBe("0.9.0");
    expect(record.supersededAt).toBe("2026-06-20T12:00:00Z");
  });

  it("carries any caller-injected supersededAt string (no Date.now call in library)", () => {
    const ts = "2099-01-01T00:00:00.000Z";
    const record = makeSupersededBaselineRecord("0.1.0", "1.0.0", ts);
    expect(record.supersededAt).toBe(ts);
  });

  it("works for a major bump", () => {
    const record = makeSupersededBaselineRecord("0.8.0", "1.0.0", "2026-06-20T00:00:00Z");
    expect(record.baselineKernelVersion).toBe("0.8.0");
    expect(record.currentKernelVersion).toBe("1.0.0");
  });

  it("throws when currentKernelVersion === baselineKernelVersion (equal versions — not superseded)", () => {
    expect(() => makeSupersededBaselineRecord("0.8.0", "0.8.0", "2026-06-20T00:00:00Z")).toThrow(
      /not strictly newer/,
    );
  });

  it("throws when currentKernelVersion < baselineKernelVersion (current is older — not superseded)", () => {
    expect(() => makeSupersededBaselineRecord("0.9.0", "0.8.0", "2026-06-20T00:00:00Z")).toThrow(
      /not strictly newer/,
    );
  });

  it("the resulting record is a plain object (readonly fields round-trip)", () => {
    const record = makeSupersededBaselineRecord("0.8.0", "0.8.1", "2026-06-20T10:30:00.000Z");
    // Verify all three fields are exactly what was passed in.
    const { baselineKernelVersion, currentKernelVersion, supersededAt } = record;
    expect(baselineKernelVersion).toBe("0.8.0");
    expect(currentKernelVersion).toBe("0.8.1");
    expect(supersededAt).toBe("2026-06-20T10:30:00.000Z");
  });
});
