import { describe, expect, it } from "vitest";
import {
  ALLOWED_LICENSES,
  auditPackages,
  isLicenseAllowed,
  parsePnpmLicenses,
  type PackageRecord,
} from "./license-audit.ts";

/**
 * Tests for the dependency-license audit (bead iaj-E05e, license audit per GC
 * binding). The script's I/O surface (`pnpm licenses list --json`) is a thin
 * shell-out; the load-bearing logic is the SPDX classifier + the parser, which
 * are pure and covered here.
 */

describe("isLicenseAllowed", () => {
  it("allows the standard permissive identifiers", () => {
    for (const lic of ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]) {
      expect(isLicenseAllowed(lic)).toBe(true);
    }
  });

  it("rejects copyleft licenses (GC decision, not engineering)", () => {
    for (const lic of ["GPL-3.0-only", "LGPL-3.0", "AGPL-3.0", "MPL-2.0", "EPL-2.0"]) {
      expect(isLicenseAllowed(lic)).toBe(false);
    }
  });

  it("passes an OR-expression when any disjunct is permissive", () => {
    expect(isLicenseAllowed("(MIT OR WTFPL)")).toBe(true);
    expect(isLicenseAllowed("(BSD-2-Clause OR MIT OR Apache-2.0)")).toBe(true);
    expect(isLicenseAllowed("(GPL-3.0-only OR MIT)")).toBe(true);
  });

  it("fails an OR-expression when no disjunct is permissive", () => {
    expect(isLicenseAllowed("(GPL-3.0-only OR LGPL-3.0)")).toBe(false);
  });

  it("does not auto-pass AND-expressions (combined obligations need review)", () => {
    expect(isLicenseAllowed("(MIT AND Apache-2.0)")).toBe(false);
    expect(isLicenseAllowed("(MIT AND GPL-3.0-only)")).toBe(false);
  });

  it("fails closed on empty, unknown, or SEE-LICENSE strings", () => {
    expect(isLicenseAllowed("")).toBe(false);
    expect(isLicenseAllowed("UNKNOWN")).toBe(false);
    expect(isLicenseAllowed("SEE LICENSE IN LICENSE.txt")).toBe(false);
    expect(isLicenseAllowed("Custom")).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isLicenseAllowed("  MIT  ")).toBe(true);
  });
});

describe("parsePnpmLicenses", () => {
  it("flattens the pnpm grouped-by-license JSON shape", () => {
    const raw = JSON.stringify({
      MIT: [
        { name: "commander", versions: ["15.0.0"], license: "MIT", paths: [] },
        { name: "chalk", versions: ["5.4.0"], license: "MIT", paths: [] },
      ],
      "Apache-2.0": [
        { name: "@intentsolutions/core", versions: ["0.5.0"], license: "Apache-2.0", paths: [] },
      ],
    });
    const recs = parsePnpmLicenses(raw);
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.name).sort()).toEqual(["@intentsolutions/core", "chalk", "commander"]);
    expect(recs.find((r) => r.name === "commander")?.license).toBe("MIT");
  });

  it("returns an empty list for empty input", () => {
    expect(parsePnpmLicenses("")).toEqual([]);
    expect(parsePnpmLicenses("   ")).toEqual([]);
  });

  it("defaults missing fields rather than throwing", () => {
    const raw = JSON.stringify({ MIT: [{ paths: [] }] });
    const recs = parsePnpmLicenses(raw);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.name).toBe("<unknown>");
    expect(recs[0]?.license).toBe("UNKNOWN");
    expect(recs[0]?.versions).toEqual([]);
  });

  it("throws on a non-object top level", () => {
    expect(() => parsePnpmLicenses("42")).toThrowError(/not an object/);
  });
});

describe("auditPackages", () => {
  const packages: PackageRecord[] = [
    { name: "commander", versions: ["15.0.0"], license: "MIT" },
    { name: "@intentsolutions/core", versions: ["0.5.0"], license: "Apache-2.0" },
    { name: "rc", versions: ["1.2.8"], license: "(BSD-2-Clause OR MIT OR Apache-2.0)" },
    { name: "evil-copyleft", versions: ["1.0.0"], license: "GPL-3.0-only" },
  ];

  it("separates allowed from violations", () => {
    const result = auditPackages(packages);
    expect(result.total).toBe(4);
    expect(result.allowed.map((p) => p.name).sort()).toEqual([
      "@intentsolutions/core",
      "commander",
      "rc",
    ]);
    expect(result.violations.map((p) => p.name)).toEqual(["evil-copyleft"]);
  });

  it("tallies a per-license histogram", () => {
    const result = auditPackages(packages);
    expect(result.byLicense.get("MIT")).toBe(1);
    expect(result.byLicense.get("GPL-3.0-only")).toBe(1);
  });

  it("reports zero violations on an all-permissive graph", () => {
    const clean = packages.filter((p) => p.name !== "evil-copyleft");
    const result = auditPackages(clean);
    expect(result.violations).toHaveLength(0);
  });
});

describe("ALLOWED_LICENSES policy set", () => {
  it("contains Apache-2.0 itself (the repo license) and excludes GPL", () => {
    expect(ALLOWED_LICENSES.has("Apache-2.0")).toBe(true);
    expect(ALLOWED_LICENSES.has("GPL-3.0-only")).toBe(false);
  });
});
