import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecker, runAllRegisteredCheckers } from "./registry.js";
import type { MMCategory, MMFixture } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = resolve(__dirname, "../../fixtures/mm-traces");

const NEW_CATEGORIES: MMCategory[] = ["MM-2", "MM-3", "MM-4", "MM-5", "MM-6"];

describe.each(NEW_CATEGORIES)("%s — fixture-driven", (category) => {
  const dir = resolve(fixturesRoot, category);
  const fixtures = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as MMFixture);

  it.each(fixtures.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    const result = runChecker(fixture.category, fixture.events);
    expect(result.category).toBe(fixture.category);
    expect(result.result).toBe(fixture.expected);
  });
});

describe("runAllRegisteredCheckers — full registry coverage", () => {
  it("now registers all 6 MM checkers (MM-1..MM-6)", () => {
    const results = runAllRegisteredCheckers([]);
    const cats = results.map((r) => r.category).sort();
    expect(cats).toEqual(["MM-1", "MM-2", "MM-3", "MM-4", "MM-5", "MM-6"]);
  });

  it("returns NOT_APPLICABLE for every checker on an empty trace (no inputs to evaluate against)", () => {
    const results = runAllRegisteredCheckers([]);
    expect(results.every((r) => r.result === "NOT_APPLICABLE")).toBe(true);
  });
});
