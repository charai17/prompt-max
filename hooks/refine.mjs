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
  timeoutMs: 120000,
  quiet: false,
};

/** Decide whether a prompt bypasses the refiner. Returns a reason or null. */
export function shouldSkip(prompt, env, config) {
  if (env.PROMPT_MAX_CHILD) return "child";
  if (env.PROMPT_MAX_OFF) return "off";
  const text = prompt.trim();
  if (text.startsWith("/")) return "slash-command";
  if (text.startsWith("!raw")) return "raw";
  if (wordCount(text) < config.minWords) return "short";
  return null;
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The last few things the person and Claude actually said, from a Claude Code
 * transcript (JSONL). Tool calls, tool results, thinking and injected meta
 * messages are dropped: the refiner needs the conversation, not the machinery.
 */
export function transcriptTail(jsonl, { maxTurns, maxCharsPerTurn }) {
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
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const ROLE = "You are Prompt Max, a prompt refiner. Follow <prompt_max_instructions> exactly and reply with the refined prompt only.";

/**
 * The whole hook, minus I/O. Returns the JSON to print (or null to let the raw
 * prompt through) and the reason, so the caller can log it.
 */
export async function runHook(payload, deps) {
  const outcome = await decide(payload, deps);
  deps.log(`${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
  return { output: outcome.output ?? null, reason: outcome.reason };
}

async function decide(payload, deps) {
  const { env, config, recipe, hookDir, readFile, runClaude, writeRewrite, now } = deps;
  const skip = shouldSkip(payload.prompt, env, config);
  if (skip) return { reason: skip };

  const excerpt = transcriptTail(readFile(payload.transcript_path) ?? "", config);
  const input = buildRefinerInput({ recipe, excerpt, cwd: payload.cwd, prompt: payload.prompt });

  const started = now();
  let result;
  try {
    result = await runClaude({
      args: childArgs(config, hookDir),
      input,
      env: { ...env, PROMPT_MAX_CHILD: "1" },
      cwd: payload.cwd,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    return { reason: "error", detail: error.message };
  }
  const seconds = Math.round((now() - started) / 1000);

  if (result.timedOut) return { reason: "timeout", detail: `${config.timeoutMs}ms` };
  if (result.code !== 0) return { reason: "child-failed", detail: `exit ${result.code}: ${result.stderr.trim()}` };
  if (result.stdout.trim() === "PASS") return { reason: "pass" };

  const refined = extractRefined(result.stdout);
  if (!refined) return { reason: "no-refined-prompt", detail: result.stdout.trim().slice(0, 200) };

  writeRewrite(rewriteRecord(payload.prompt, refined));
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

function extractRefined(stdout) {
  const match = /<refined_prompt>([\s\S]*?)<\/refined_prompt>/.exec(stdout);
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
    "<refined_prompt>",
    refined,
    "</refined_prompt>",
    "</prompt_max>",
  ].join("\n");
  const output = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  if (!config.quiet) output.systemMessage = `Prompt Max refined this message (${seconds}s)`;
  return output;
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

// ---------------------------------------------------------------------------
// I/O shell. Everything above is pure; everything below touches the machine.
// ---------------------------------------------------------------------------

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(HOOK_DIR);
const STATE_DIR = join(homedir(), ".claude", "prompt-max");

/** config.json in the skill folder, then environment overrides, then defaults. */
export function loadConfig(env, skillDir = SKILL_DIR) {
  const file = join(skillDir, "config.json");
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const fromEnv = {
    model: env.PROMPT_MAX_MODEL,
    effort: env.PROMPT_MAX_EFFORT,
    minWords: env.PROMPT_MAX_MIN_WORDS && Number(env.PROMPT_MAX_MIN_WORDS),
    quiet: env.PROMPT_MAX_QUIET ? env.PROMPT_MAX_QUIET !== "0" : undefined,
  };
  const defined = Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v !== undefined && v !== ""));
  return { ...DEFAULT_CONFIG, ...fromFile, ...defined };
}

/** Find the claude binary: explicit override, then PATH (with Windows extensions). */
export function resolveClaude(env) {
  if (env.PROMPT_MAX_CLAUDE_BIN) return env.PROMPT_MAX_CLAUDE_BIN;
  const isWindows = process.platform === "win32";
  const names = isWindows ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"];
  const dirs = [join(homedir(), ".local", "bin"), ...(env.PATH ?? env.Path ?? "").split(delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "claude";
}

/** Run the headless refiner: input on stdin, text on stdout, hard timeout. */
export function runClaudeProcess({ args, input, env, cwd, timeoutMs }) {
  const bin = resolveClaude(env);
  const viaCmdShim = process.platform === "win32" && [".cmd", ".bat"].includes(extname(bin).toLowerCase());
  const child = viaCmdShim
    ? spawn(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", cmdLine([bin, ...args])], { env, cwd, windowsVerbatimArguments: true })
    : spawn(bin, args, { env, cwd });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function cmdLine(parts) {
  return parts.map((part) => `"${String(part).replace(/"/g, '\\"')}"`).join(" ");
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

async function main() {
  const env = process.env;
  const payload = JSON.parse((await readStdin()) || "{}");
  if (typeof payload.prompt !== "string") return;
  mkdirSync(STATE_DIR, { recursive: true });

  const { output } = await runHook(payload, {
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
    writeRewrite: (text) => writeFileSync(join(STATE_DIR, "last-rewrite.md"), text),
    log: (line) => appendFileSync(join(STATE_DIR, "runs.log"), `${new Date().toISOString()} ${line}\n`),
    now: Date.now,
  });
  if (output) process.stdout.write(JSON.stringify(output));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((error) => {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      appendFileSync(join(STATE_DIR, "runs.log"), `${new Date().toISOString()} fatal — ${error.message}\n`);
    } catch {}
    process.exit(0);
  });
}
