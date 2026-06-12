import { describe, it, expect } from 'vitest';
import { parseCoverageFloor } from './emit-evidence.ts';

describe('parseCoverageFloor [f-jrig-security-2]', () => {
  it('reads the lines floor declared inside a coverage.thresholds block', () => {
    const cfg = `
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: {
        branches: 70,
        lines: 80,
      },
    },
  },
});
`;
    expect(parseCoverageFloor(cfg)).toBe(80);
  });

  it('does NOT fabricate a floor from a lines: token in a comment', () => {
    const cfg = `
export default defineConfig({
  test: {
    coverage: {
      // maybe declare a floor later, e.g. lines: 5
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
});
`;
    expect(parseCoverageFloor(cfg)).toBeNull();
  });

  it('does NOT fabricate a floor from a non-thresholds lines: option', () => {
    const cfg = `
export default defineConfig({
  test: {
    coverage: {
      watermarks: { lines: 50 },
    },
  },
});
`;
    // No thresholds block at all → no declared floor.
    expect(parseCoverageFloor(cfg)).toBeNull();
  });

  it('returns null when the config declares no floor (current repo state)', () => {
    const cfg = `
export default defineConfig({
  test: {
    globals: true,
    coverage: { provider: 'v8', reporter: ['text'] },
  },
});
`;
    expect(parseCoverageFloor(cfg)).toBeNull();
  });
});
