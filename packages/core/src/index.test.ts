import { describe, it, expect } from "vitest";
import { VERSION } from "./index.js";

describe("@j-rig/core", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
