import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { makeSkillDoc, type SkillDoc } from "@intentsolutions/refiner-core";

/** Load one skill with a consistent ID for absolute paths, relative paths and `.`. */
export function loadSkillDoc(skillDir: string): SkillDoc {
  const directory = resolve(skillDir);
  return makeSkillDoc(basename(directory), readFileSync(join(directory, "SKILL.md"), "utf8"));
}
