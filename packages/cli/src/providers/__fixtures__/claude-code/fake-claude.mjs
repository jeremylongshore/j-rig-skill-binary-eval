#!/usr/bin/env node
// Test double for the `claude` binary. CI never runs real Claude Code: the
// claude-code provider tests point `claudeBin` here, and this script replays a
// RECORDED stream-json transcript (recorded locally on the Claude
// subscription, then scrubbed: the temp root is `__ROOT__`, uuids are
// renumbered, account rate-limit events are dropped).
//
// The mode comes from the -p prompt, because the provider passes the agent
// only an allowlisted environment:
//   "FIXTURE <name>"  write <name>.files.json into cwd, replay <name>.stream.jsonl
//   "HANG"            print an init event, then never finish (timeout test)
//   "APIKEY"          print an init event reporting an API key source, then hang
//   "CRASH"           print an auth error on stderr and exit 1 with no result
//   "ENV"             write env.json (env keys, HOME, sandbox credential keys)
//                     and replay the read-missing transcript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setInterval } from "node:timers";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] ?? "";
const cwd = process.cwd();
const root = dirname(cwd);

const init = (apiKeySource) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    cwd,
    tools: ["Bash", "Read", "Write"],
    model: "claude-haiku-5-5",
    apiKeySource,
    skills: existsSync(join(cwd, ".claude", "skills")) ? ["installed"] : [],
  }) + "\n";

function replay(name) {
  const files = JSON.parse(readFileSync(join(here, `${name}.files.json`), "utf8")).files;
  for (const [p, content] of Object.entries(files)) {
    const dest = join(cwd, p);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest) || readFileSync(dest, "utf8") !== content) writeFileSync(dest, content);
  }
  const stream = readFileSync(join(here, `${name}.stream.jsonl`), "utf8");
  process.stdout.write(stream.split("__ROOT__").join(root));
}

const [mode, name] = prompt.split(" ");
if (mode === "FIXTURE") {
  replay(name);
} else if (mode === "HANG" || mode === "APIKEY") {
  process.stdout.write(init(mode === "APIKEY" ? "ANTHROPIC_API_KEY" : "none"));
  setInterval(() => {}, 1000);
} else if (mode === "CRASH") {
  process.stderr.write("Invalid API key · Please run /login (authentication failed)\n");
  process.exit(1);
} else if (mode === "ENV") {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? "";
  const creds = JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8"));
  writeFileSync(
    join(cwd, "env.json"),
    JSON.stringify({
      keys: Object.keys(process.env).sort(),
      home: process.env.HOME,
      configDir,
      credentialKeys: Object.keys(creds.claudeAiOauth ?? {}).sort(),
      skillInstalled: existsSync(join(cwd, ".claude", "skills")),
    }),
  );
  replay("read-missing");
} else {
  process.stderr.write(`fake-claude: unknown mode ${JSON.stringify(prompt)}\n`);
  process.exit(2);
}
