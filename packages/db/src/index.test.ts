import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDatabase,
  type JRigDatabase,
  getOrCreateSkillVersion,
  createRun,
  transitionRun,
  storeCriterionResults,
  storeRunSummary,
  recordArtifact,
  getRun,
  getRecentRuns,
  getRunResults,
  getRunArtifacts,
  isValidTransition,
  isTerminal,
  allowedTransitions,
  DB_VERSION,
} from "./index.js";

describe("@j-rig/db", () => {
  it("exports DB_VERSION", () => {
    expect(DB_VERSION).toBe("0.0.0");
  });
});

describe("database", () => {
  let database: JRigDatabase;

  beforeEach(() => {
    database = createDatabase(":memory:");
  });

  afterEach(() => {
    database.close();
  });

  it("creates an in-memory database", () => {
    expect(database.db).toBeTruthy();
  });

  it("creates skill versions", () => {
    const id = getOrCreateSkillVersion(database, "test-skill", "1.0.0", "content");
    expect(id).toBeGreaterThan(0);
  });

  it("deduplicates skill versions by content hash", () => {
    const id1 = getOrCreateSkillVersion(database, "test-skill", "1.0.0", "same content");
    const id2 = getOrCreateSkillVersion(database, "test-skill", "1.0.0", "same content");
    expect(id1).toBe(id2);
  });

  it("creates different versions for different content", () => {
    const id1 = getOrCreateSkillVersion(database, "test-skill", "1.0.0", "v1");
    const id2 = getOrCreateSkillVersion(database, "test-skill", "1.1.0", "v2");
    expect(id1).not.toBe(id2);
  });
});

describe("run lifecycle", () => {
  let database: JRigDatabase;
  let svId: number;

  beforeEach(() => {
    database = createDatabase(":memory:");
    svId = getOrCreateSkillVersion(database, "test-skill", "1.0.0", "content");
  });

  afterEach(() => {
    database.close();
  });

  it("creates a run in pending state", () => {
    const runId = createRun(database, svId);
    const run = getRun(database, runId);
    expect(run?.status).toBe("pending");
  });

  it("transitions pending → running → completed", () => {
    const runId = createRun(database, svId);
    transitionRun(database, runId, "running");
    const running = getRun(database, runId);
    expect(running?.status).toBe("running");
    expect(running?.started_at).toBeTruthy();

    transitionRun(database, runId, "completed");
    const completed = getRun(database, runId);
    expect(completed?.status).toBe("completed");
    expect(completed?.completed_at).toBeTruthy();
  });

  it("rejects invalid transitions", () => {
    const runId = createRun(database, svId);
    expect(() => transitionRun(database, runId, "completed")).toThrow("Invalid transition");
  });

  it("rejects transitions from terminal states", () => {
    const runId = createRun(database, svId);
    transitionRun(database, runId, "running");
    transitionRun(database, runId, "failed");
    expect(() => transitionRun(database, runId, "running")).toThrow("Invalid transition");
  });

  it("supports cancellation from pending", () => {
    const runId = createRun(database, svId);
    transitionRun(database, runId, "canceled");
    expect(getRun(database, runId)?.status).toBe("canceled");
  });

  it("supports timeout from running", () => {
    const runId = createRun(database, svId);
    transitionRun(database, runId, "running");
    transitionRun(database, runId, "timed_out");
    expect(getRun(database, runId)?.status).toBe("timed_out");
  });
});

describe("lifecycle helpers", () => {
  it("validates transitions correctly", () => {
    expect(isValidTransition("pending", "running")).toBe(true);
    expect(isValidTransition("pending", "completed")).toBe(false);
    expect(isValidTransition("running", "completed")).toBe(true);
    expect(isValidTransition("completed", "running")).toBe(false);
  });

  it("identifies terminal states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("lists allowed transitions", () => {
    expect(allowedTransitions("pending")).toEqual(["running", "canceled"]);
    expect(allowedTransitions("completed")).toEqual([]);
  });
});

describe("evidence persistence", () => {
  let database: JRigDatabase;
  let svId: number;
  let runId: number;

  beforeEach(() => {
    database = createDatabase(":memory:");
    svId = getOrCreateSkillVersion(database, "test-skill", "1.0.0", "content");
    runId = createRun(database, svId);
    transitionRun(database, runId, "running");
  });

  afterEach(() => {
    database.close();
  });

  it("stores and retrieves criterion results", () => {
    storeCriterionResults(database, runId, [
      { criterion_id: "pkg:skill-md-exists", passed: true, severity: "pass", message: "Found" },
      { criterion_id: "pkg:name-present", passed: false, severity: "error", message: "Missing", details: "No name field" },
    ]);

    const results = getRunResults(database, runId);
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[1].details).toBe("No name field");
  });

  it("stores and retrieves run summaries", () => {
    storeRunSummary(database, runId, { total: 10, passed: 8, warnings: 1, errors: 1 });
    transitionRun(database, runId, "completed");

    const run = getRun(database, runId);
    expect(run?.summary).toBeTruthy();
    expect(run?.summary?.total).toBe(10);
    expect(run?.summary?.passed).toBe(8);
    expect(run?.summary?.score).toBeCloseTo(0.8);
  });

  it("records and retrieves artifacts", () => {
    recordArtifact(database, runId, "report", "report.json", ".j-rig/runs/1/report.json", 1234);

    const arts = getRunArtifacts(database, runId);
    expect(arts).toHaveLength(1);
    expect(arts[0].artifact_type).toBe("report");
    expect(arts[0].size_bytes).toBe(1234);
  });

  it("queries recent runs", () => {
    transitionRun(database, runId, "completed");

    const run2 = createRun(database, svId);
    transitionRun(database, run2, "running");
    transitionRun(database, run2, "completed");

    const recent = getRecentRuns(database, { limit: 5 });
    expect(recent).toHaveLength(2);
    // Most recent first
    expect(recent[0].runs.id).toBe(run2);
  });

  it("queries runs by skill name", () => {
    transitionRun(database, runId, "completed");

    const sv2 = getOrCreateSkillVersion(database, "other-skill", "1.0.0", "other");
    const run2 = createRun(database, sv2);
    transitionRun(database, run2, "running");
    transitionRun(database, run2, "completed");

    const testSkillRuns = getRecentRuns(database, { skillName: "test-skill" });
    expect(testSkillRuns).toHaveLength(1);
    expect(testSkillRuns[0].skill_versions.skill_name).toBe("test-skill");
  });

  it("returns null for non-existent run", () => {
    expect(getRun(database, 9999)).toBeNull();
  });

  it("throws for non-existent run on transition", () => {
    expect(() => transitionRun(database, 9999, "running")).toThrow("not found");
  });
});
