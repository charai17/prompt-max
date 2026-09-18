// Prompt Max — UserPromptSubmit hook.
// Reads the hook payload on stdin, refines the raw prompt through a headless
// Claude session, and prints the refined prompt as additional context.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, delimiter, extname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = {
  model: "claude-opus-5",
  effort: "high",
  minWords: 8,
  maxTurns: 12,
  maxCharsPerTurn: 700,
  timeoutMs: 120000, // the installer's hook timeout (150 s) must stay above this
  quiet: false,
};

/** Prefix that sends one message through untouched. ("!" is Claude Code's shell prefix, so not that.) */
export const RAW_PREFIX = "raw:";

const REFINED_TAG = "refined_prompt";

/** Decide whether a prompt bypasses the refiner. Returns a reason or null. */
export function shouldSkip(prompt, env, config) {
  if (flag(env.PROMPT_MAX_CHILD)) return "child";
  if (flag(env.PROMPT_MAX_OFF)) return "off";
  const text = prompt.trim();
  if (text.startsWith("/")) return "slash-command";
  if (text.startsWith(RAW_PREFIX)) return "raw";
  if (wordCount(text) < config.minWords) return "short";
  return null;
}

/** Environment switches: set and not "0" means on. */
function flag(value) {
  return value !== undefined && value !== "" && value !== "0";
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The last few things the person and Claude actually said, from a Claude Code
 * transcript (JSONL). Tool calls, tool results, thinking, injected meta
 * messages and harness markup are dropped: the refiner needs the
 * conversation, not the machinery.
 */
export function transcriptTail(jsonl, { maxTurns, maxCharsPerTurn }) {
  if (maxTurns <= 0) return [];
  const turns = [];
  for (const raw of jsonl.split("\n")) {
    const entry = parseLine(raw);
    if (!entry || entry.isMeta) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const text = spokenText(entry.message?.content);
    if (!text) continue;
    turns.push({ role: entry.type, text: clip(text, maxCharsPerTurn) });
  }
  return turns.slice(-maxTurns);
}

function parseLine(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function spokenText(content) {
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text) : [];
  return parts
    .filter((part) => typeof part === "string")
    .map(stripHarnessMarkup)
    .filter(Boolean)
    .join("\n");
}

// Claude Code injects its own markup into user turns: expanded slash commands,
// reminders, local command output. None of it is something the person said.
const HARNESS_BLOCK = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|task-notification|ide_[a-z_]+)>[\s\S]*?<\/\1>/g;

function stripHarnessMarkup(text) {
  return text.replace(HARNESS_BLOCK, "").trim();
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** The single message the refiner receives: recipe, conversation, place, raw prompt. */
export function buildRefinerInput({ recipe, excerpt, cwd, prompt }) {
  const conversation = excerpt.length
    ? excerpt.map((turn) => `[${turn.role}] ${turn.text}`).join("\n")
    : "(start of conversation)";
  return [
    "<prompt_max_instructions>",
    recipe,
    "</prompt_max_instructions>",
    "",
    "<conversation_excerpt>",
    conversation,
    "</conversation_excerpt>",
    "",
    `<working_directory>${cwd}</working_directory>`,
    "",
    "<raw_prompt>",
    prompt,
    "</raw_prompt>",
  ].join("\n");
}

const ROLE = "You are Prompt Max, a prompt refiner. Follow <prompt_max_instructions> exactly and reply with the refined prompt only.";

/**
 * The whole hook, minus I/O. Returns the JSON to print (or null to let the raw
 * prompt through) and the reason, so the caller can log it.
 */
export async function runHook(payload, deps) {
  const outcome = await refineOrSkip(payload, deps);
  deps.log(`${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  return { output: outcome.output ?? null, reason: outcome.reason };
}

async function refineOrSkip(payload, deps) {
  const { env, config, recipe, hookDir, readFile, runClaude, now } = deps;
  const skip = shouldSkip(payload.prompt, env, config);
  if (skip) return { reason: skip };

  const excerpt = transcriptTail(readFile(payload.transcript_path) ?? "", config);
  const input = buildRefinerInput({ recipe, excerpt, cwd: payload.cwd, prompt: payload.prompt });
  const started = now();
  try {
    const result = await runClaude({
      args: childArgs(config, hookDir),
      input,
      env: { ...env, PROMPT_MAX_CHILD: "1" },
      cwd: payload.cwd,
      timeoutMs: config.timeoutMs,
    });
    return interpret(result, payload.prompt, Math.round((now() - started) / 1000), deps);
  } catch (error) {
    return { reason: "error", detail: error.message };
  }
}

function interpret(result, prompt, seconds, { config, writeRewrite }) {
  if (result.timedOut) return { reason: "timeout", detail: `${config.timeoutMs}ms` };
  if (result.code !== 0) return { reason: "child-failed", detail: `exit ${result.code}: ${result.stderr.trim()}` };
  const reply = result.stdout.trim();
  if (reply === "PASS") return { reason: "pass" };

  const refined = extractRefined(reply);
  if (!refined) {
    writeRewrite(rewriteRecord(prompt, `(no <${REFINED_TAG}> block in the reply; the reply was:)\n\n${reply}`));
    return { reason: "no-refined-prompt", detail: reply.slice(0, 200) };
  }
  writeRewrite(rewriteRecord(prompt, refined));
  return { reason: "refined", detail: `${seconds}s`, output: hookOutput(refined, seconds, config) };
}

function childArgs(config, hookDir) {
  return [
    "-p",
    "--model", config.model,
    "--effort", config.effort,
    "--tools", "",
    "--output-format", "text",
    "--no-session-persistence",
    "--settings", `${hookDir}/child-settings.json`,
    "--strict-mcp-config",
    "--mcp-config", `${hookDir}/no-mcp.json`,
    "--append-system-prompt", ROLE,
  ];
}

function extractRefined(reply) {
  const match = new RegExp(`<${REFINED_TAG}>([\\s\\S]*?)</${REFINED_TAG}>`).exec(reply);
  return match ? match[1].trim() : null;
}

function rewriteRecord(original, refined) {
  return `# Prompt Max rewrite\n\n## Original\n\n${original}\n\n## Refined\n\n${refined}\n`;
}

function hookOutput(refined, seconds, config) {
  const context = [
    "<prompt_max>",
    "The message above was refined by Prompt Max before reaching you. Execute the refined prompt below: it is the person's message made explicit, with the same intent and the same scope. Use the raw message only to resolve anything the refinement got wrong. Do not mention Prompt Max, the refinement, or this note; reply as if the person had written the refined prompt.",
    "",
    `<${REFINED_TAG}>`,
    refined,
    `</${REFINED_TAG}>`,
    "</prompt_max>",
  ].join("\n");
  const output = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  if (!config.quiet) output.systemMessage = `Prompt Max refined this message (${seconds}s)`;
  return output;
}

// ---------------------------------------------------------------------------
// I/O shell. Everything above is pure; everything below touches the machine.
// ---------------------------------------------------------------------------

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(HOOK_DIR);
const STATE_DIR = join(homedir(), ".claude", "prompt-max");

/** Defaults, overridden by config.json in the skill folder, overridden by environment variables. */
export function loadConfig(env, skillDir = SKILL_DIR) {
  const file = join(skillDir, "config.json");
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const minWords = Number(env.PROMPT_MAX_MIN_WORDS);
  const fromEnv = {
    model: env.PROMPT_MAX_MODEL || undefined,
    effort: env.PROMPT_MAX_EFFORT || undefined,
    minWords: Number.isFinite(minWords) && env.PROMPT_MAX_MIN_WORDS !== "" ? minWords : undefined,
    quiet: env.PROMPT_MAX_QUIET !== undefined ? flag(env.PROMPT_MAX_QUIET) : undefined,
  };
  const defined = Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_CONFIG, ...fromFile, ...defined };
}

/** Find the claude binary: explicit override, then ~/.local/bin, then PATH (with Windows extensions). */
export function resolveClaude(env, { platform = process.platform, home = homedir() } = {}) {
  if (env.PROMPT_MAX_CLAUDE_BIN) return env.PROMPT_MAX_CLAUDE_BIN;
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"];
  const dirs = [join(home, ".local", "bin"), ...(env.PATH ?? env.Path ?? "").split(delimiter)];
  for (const dir of dirs.filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "claude";
}

/** Run the headless refiner: input on stdin, text on stdout, hard timeout. */
export function runClaudeProcess({ args, input, env, cwd, timeoutMs }) {
  const child = spawnClaude(resolveClaude(env), args, { env, cwd: cwd && existsSync(cwd) ? cwd : undefined });
  return collect(child, input, timeoutMs);
}

// npm installs `claude.cmd` on Windows; a .cmd shim only runs through cmd.exe,
// which needs the whole line quoted once more than the individual arguments.
function spawnClaude(bin, args, options) {
  const viaCmdShim = process.platform === "win32" && [".cmd", ".bat"].includes(extname(bin).toLowerCase());
  if (!viaCmdShim) return spawn(bin, args, options);
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${cmdLine([bin, ...args])}"`], { ...options, windowsVerbatimArguments: true });
}

function cmdLine(parts) {
  for (const part of parts) if (String(part).includes('"')) throw new Error(`cmd.exe cannot carry a quote inside an argument: ${part}`);
  return parts.map((part) => `"${part}"`).join(" ");
}

function collect(child, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => (clearTimeout(timer), reject(error)));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr, timedOut })));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// On Windows the child may be cmd.exe with claude underneath; kill the tree.
function killTree(child) {
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => child.kill());
  else child.kill();
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function logLine(line) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(join(STATE_DIR, "runs.log"), `${new Date().toISOString()} ${line}\n`);
}

function machineDeps(env) {
  return {
    env,
    config: loadConfig(env),
    recipe: readFileSync(join(SKILL_DIR, "prompt.md"), "utf8"),
    hookDir: HOOK_DIR,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    runClaude: runClaudeProcess,
    writeRewrite: (text) => (mkdirSync(STATE_DIR, { recursive: true }), writeFileSync(join(STATE_DIR, "last-rewrite.md"), text)),
    log: logLine,
    now: Date.now,
  };
}

async function main() {
  const payload = JSON.parse((await readStdin()) || "{}");
  if (typeof payload.prompt !== "string") return;
  const { output } = await runHook(payload, machineDeps(process.env));
  if (output) process.stdout.write(JSON.stringify(output));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    try {
      logLine(`fatal — ${error.message}`);
    } catch {}
    process.exit(0);
  });
}
