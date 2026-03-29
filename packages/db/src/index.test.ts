import { describe, it, expect } from "vitest";
import { DB_VERSION } from "./index.js";

describe("@j-rig/db", () => {
  it("exports DB_VERSION", () => {
    expect(DB_VERSION).toBe("0.0.0");
  });
});
