import { noRuntimeSources } from "./workspace-coverage-types.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "ast-v8-to-istanbul";
import { parseAstAsync } from "vite";
import libCoverage from "istanbul-lib-coverage";
import type { CoverageMapData } from "istanbul-lib-coverage";
import type {
  CapturedScript,
  FlushReceipt,
  ReporterReceipt,
  CoverageManifest,
} from "./workspace-coverage-contract.ts";
import {
  CollectionError,
  readManifest,
  sha256,
  verifySources,
} from "./workspace-coverage-contract.ts";

function requireCondition(value: unknown, reason: string): asserts value {
  if (!value) throw new CollectionError(reason);
}
interface WrapperNode {
  type: string;
  start: number;
  end: number;
  expression?: WrapperNode;
  body?: WrapperNode[] | WrapperNode;
}

export async function convertScript(
  script: CapturedScript,
  coverage: FlushReceipt["coverage"][number],
  manifest: CoverageManifest,
) {
  const path = relative(manifest.root, fileURLToPath(script.parsed.url));
  const entry = manifest.files.find((file) => file.path === path);
  requireCondition(entry, "Captured script outside inventory");
  requireCondition(
    script.parsed.scriptId === coverage.scriptId && script.parsed.url === coverage.url,
    `Script/coverage identity mismatch: ${path}`,
  );
  const sourceMapURL = script.parsed.sourceMapURL;
  requireCondition(
    typeof sourceMapURL === "string" &&
      /^data:application\/json;(?:charset=utf-8;)?base64,/.test(sourceMapURL),
    `Missing inline source map: ${path}`,
  );
  requireCondition(
    script.source.includes(`sourceMappingURL=${sourceMapURL}`),
    `Changed map receipt: ${path}`,
  );
  const map = JSON.parse(Buffer.from(sourceMapURL.split(",")[1], "base64").toString());
  requireCondition(
    map.version === 3 &&
      Array.isArray(map.sources) &&
      map.sources.length === 1 &&
      Array.isArray(map.sourcesContent) &&
      map.sourcesContent.length === 1 &&
      typeof map.sourcesContent[0] === "string" &&
      typeof map.sources[0] === "string" &&
      typeof map.mappings === "string" &&
      map.mappings.length > 0 &&
      (!map.sourceRoot || map.sourceRoot === ""),
    `Unsupported source map: ${path}`,
  );
  const mapped = map.sources[0].startsWith("file:")
    ? fileURLToPath(map.sources[0])
    : resolve(dirname(fileURLToPath(script.parsed.url)), map.sources[0]);
  requireCondition(
    mapped === resolve(manifest.root, path) && sha256(map.sourcesContent[0]) === entry.sha256,
    `Source-map bytes differ from inventory: ${path}`,
  );
  const ast = await parseAstAsync(script.source);
  const nodes = ast.body as unknown as WrapperNode[];
  const wrapper = nodes[1]?.expression;
  const body = wrapper?.body as WrapperNode | undefined;
  const inner = (body?.body as WrapperNode[] | undefined)?.[0];
  const offset = (inner?.start ?? -1) + 1;
  // Vite's VM wrapper is not public API. Accept it only when its AST shape
  // and Inspector's recorded displacement independently agree; otherwise stop.
  requireCondition(
    nodes.length === 2 &&
      nodes[0].type === "ExpressionStatement" &&
      wrapper?.type === "ArrowFunctionExpression" &&
      body?.type === "BlockStatement" &&
      Array.isArray(body.body) &&
      body.body.length === 1 &&
      inner?.type === "BlockStatement" &&
      script.parsed.startLine === 0 &&
      offset > 0 &&
      offset === -script.parsed.startColumn,
    `Unverified execution wrapper: ${path}`,
  );
  const code = script.source.slice(offset, inner.end - 1);
  for (const fn of coverage.functions)
    for (const range of fn.ranges) {
      requireCondition(
        Number.isSafeInteger(range.startOffset) &&
          Number.isSafeInteger(range.endOffset) &&
          range.startOffset >= 0 &&
          range.startOffset < range.endOffset &&
          range.endOffset <= script.source.length &&
          Number.isSafeInteger(range.count) &&
          range.count >= 0,
        `Invalid execution range: ${path}`,
      );
    }
  const converted = await convert({
    ast: parseAstAsync(code),
    code,
    wrapperLength: offset,
    coverage,
    sourceMap: map,
  });
  requireCondition(
    Object.keys(converted).length === 1 && Object.keys(converted)[0] === mapped,
    `Converted coverage inventory mismatch: ${path}`,
  );
  const lines: string[] = map.sourcesContent[0].split("\n");
  function finiteEnds(value: unknown) {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const end = record.end as { line?: number; column?: number } | undefined;
    // ast-v8-to-istanbul 0.3.12 uses Infinity for the end-of-original-line
    // sentinel when there is no later mapping (Locator.getLoc). Materialize
    // only this known in-memory sentinel, never JSON null or arbitrary NaN.
    if (end?.column === Infinity) {
      requireCondition(
        Number.isInteger(end.line) && end.line! >= 1 && end.line! <= lines.length,
        `Invalid end-of-line sentinel: ${path}`,
      );
      end.column = lines[end.line! - 1].length;
    }
    for (const child of Object.values(record)) finiteEnds(child);
  }
  finiteEnds(converted);
  return {
    converted,
    evidence: {
      path,
      scriptId: script.parsed.scriptId,
      executionContextId: script.parsed.executionContextId,
      sourceSha256: entry.sha256,
      executedSha256: sha256(script.source),
      mapSha256: sha256(sourceMapURL),
      wrapperOffset: offset,
    },
  };
}

export async function reconcileCoverage(directory: string, exitCode: number | null) {
  const { manifest, manifestHash } = readManifest(directory);
  verifySources(manifest);
  const exclusions = noRuntimeSources(manifest);
  const excluded = new Set(exclusions.map((file) => file.path));
  requireCondition(exitCode === 0, "Test process failed or was interrupted");
  const reporter = JSON.parse(
    readFileSync(join(directory, "reporter.json"), "utf8"),
  ) as ReporterReceipt;
  requireCondition(
    reporter.runId === manifest.runId &&
      reporter.manifestHash === manifestHash &&
      reporter.reason === "passed" &&
      reporter.errors === 0,
    "Missing or failed reporter completion",
  );
  const tests = manifest.files
    .filter((file) => file.kind === "test")
    .map((file) => file.path)
    .sort();
  requireCondition(
    JSON.stringify(reporter.modules.map((module) => module.path).sort()) === JSON.stringify(tests),
    "Reporter test inventory mismatch",
  );
  const starts = readdirSync(directory).filter((name) => name.endsWith(".start.json"));
  const flushes = readdirSync(directory).filter((name) => name.endsWith(".flush.json"));
  requireCondition(
    starts.length === tests.length && flushes.length === starts.length,
    "Missing worker flush receipt",
  );
  const map = libCoverage.createCoverageMap({});
  const evidence = [];
  const measured = new Set<string>();
  const seenTests = new Set<string>();
  for (const name of starts.sort()) {
    const start = JSON.parse(readFileSync(join(directory, name), "utf8")) as FlushReceipt;
    const receipt = JSON.parse(
      readFileSync(join(directory, name.replace(".start.json", ".flush.json")), "utf8"),
    ) as FlushReceipt;
    const ended = reporter.modules.find((module) => module.path === receipt.testPath);
    requireCondition(
      start.token === receipt.token &&
        receipt.runId === manifest.runId &&
        receipt.manifestHash === manifestHash &&
        start.manifestHash === manifestHash &&
        start.runId === manifest.runId &&
        start.pid === receipt.pid &&
        start.threadId === receipt.threadId &&
        start.poolId === receipt.poolId &&
        start.testPath === receipt.testPath &&
        start.startedAt === receipt.startedAt &&
        Number.isSafeInteger(receipt.pid) &&
        receipt.pid > 0 &&
        receipt.threadId === 0 &&
        receipt.poolId.length > 0 &&
        ended?.state === "passed" &&
        receipt.flushedAt >= receipt.startedAt &&
        ended.endedAt >= receipt.flushedAt &&
        receipt.errors.length === 0 &&
        !seenTests.has(receipt.testPath),
      "Invalid or late worker flush receipt",
    );
    seenTests.add(receipt.testPath);
    requireCondition(
      receipt.coverage.length > 0 && receipt.scripts.length === receipt.coverage.length,
      "Missing script/map capture",
    );
    const scriptIds = new Set<string>();
    for (const row of receipt.coverage) {
      requireCondition(!scriptIds.has(row.scriptId), "Duplicate script coverage receipt");
      scriptIds.add(row.scriptId);
      const captures = receipt.scripts.filter((script) => script.parsed.scriptId === row.scriptId);
      requireCondition(captures.length === 1, "Missing or duplicate captured map");
      if (excluded.has(relative(manifest.root, fileURLToPath(row.url)))) continue;
      const result = await convertScript(captures[0], row, manifest);
      map.merge(result.converted);
      measured.add(result.evidence.path);
      evidence.push({
        token: receipt.token,
        pid: receipt.pid,
        threadId: receipt.threadId,
        testPath: receipt.testPath,
        startedAt: receipt.startedAt,
        flushedAt: receipt.flushedAt,
        ...result.evidence,
      });
    }
    requireCondition(
      receipt.coverage.some(
        (row) => relative(manifest.root, fileURLToPath(row.url)) === receipt.testPath,
      ),
      "Test module had no execution coverage",
    );
  }
  const missing = manifest.files
    .filter((file) => !measured.has(file.path) && !excluded.has(file.path))
    .map((file) => file.path);
  requireCondition(missing.length === 0, `Unobserved inventory files: ${missing.join(", ")}`);
  verifySources(manifest);
  return {
    coverage: map.toJSON() as CoverageMapData,
    report: {
      schemaVersion: "workspace-coverage/v1",
      complete: true,
      runId: manifest.runId,
      manifestHash,
      inventory: manifest.files,
      noRuntimeExclusions: exclusions,
      counts: {
        requestedFiles: manifest.files.length,
        observedFiles: measured.size,
        noRuntimeFiles: exclusions.length,
      },
      evidence,
      captureBoundary:
        "Public setupFiles start through final afterAll; excludes environment teardown and post-module async work",
      identityScope:
        "Caller source snapshots, captured inline maps, and observed script execution; not an independent execution attestation",
      basis:
        "Istanbul statements remapped from observed V8 execution; no coverage synthesized for unloaded files",
    },
  };
}
