import { describe, it, expect } from "vitest";
import { main } from "./index.js";

describe("@j-rig/cli", () => {
  it("exports main function", () => {
    expect(typeof main).toBe("function");
  });
});
