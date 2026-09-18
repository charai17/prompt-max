import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSkip, transcriptTail, buildRefinerInput, runHook } from "./refine.mjs";

const config = { minWords: 8 };

const line = (obj) => JSON.stringify(obj);
const transcript = [
  line({ type: "user", message: { role: "user", content: "make the footer match the header" } }),
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Which header colour, the dark one?" }] } }),
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }),
  line({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: C:\\skills\\x" }] } }),
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } }),
  line({ type: "file-history-snapshot", snapshot: {} }),
  line({ type: "user", message: { role: "user", content: [{ type: "text", text: "the dark one" }] } }),
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done: footer now uses the dark header palette." }] } }),
].join("\n");

test("a slash command passes through untouched", () => {
  assert.equal(shouldSkip("/commit all the things now please thanks a lot", {}, config), "slash-command");
});

test("a short reply passes through untouched", () => {
  assert.equal(shouldSkip("yes do it", {}, config), "short");
  assert.equal(shouldSkip("the second one, keep the header blue", {}, config), "short");
});

test("a prompt at the word threshold is refined", () => {
  assert.equal(shouldSkip("make the landing page hero feel more premium please", {}, config), null);
});

test("the !raw prefix is an explicit bypass", () => {
  assert.equal(shouldSkip("!raw make the landing page hero feel more premium please", {}, config), "raw");
});

test("PROMPT_MAX_OFF disables the pipeline", () => {
  assert.equal(shouldSkip("make the landing page hero feel more premium please", { PROMPT_MAX_OFF: "1" }, config), "off");
});

test("the child refiner session never re-enters the hook", () => {
  assert.equal(shouldSkip("make the landing page hero feel more premium please", { PROMPT_MAX_CHILD: "1" }, config), "child");
});

test("a blank prompt passes through", () => {
  assert.equal(shouldSkip("   ", {}, config), "short");
});

test("transcript tail keeps only what the person and Claude said, oldest first", () => {
  assert.deepEqual(transcriptTail(transcript, { maxTurns: 12, maxCharsPerTurn: 700 }), [
    { role: "user", text: "make the footer match the header" },
    { role: "assistant", text: "Which header colour, the dark one?" },
    { role: "user", text: "the dark one" },
    { role: "assistant", text: "Done: footer now uses the dark header palette." },
  ]);
});

test("transcript tail is capped to the newest N turns", () => {
  const tail = transcriptTail(transcript, { maxTurns: 2, maxCharsPerTurn: 700 });
  assert.deepEqual(tail.map((t) => t.text), ["the dark one", "Done: footer now uses the dark header palette."]);
});

test("long turns are truncated with a marker", () => {
  const long = line({ type: "user", message: { role: "user", content: "a".repeat(50) } });
  const [turn] = transcriptTail(long, { maxTurns: 5, maxCharsPerTurn: 10 });
  assert.equal(turn.text, "aaaaaaaaaa…");
});

test("a malformed line is ignored rather than fatal", () => {
  const tail = transcriptTail("not json\n" + transcript.split("\n")[0], { maxTurns: 5, maxCharsPerTurn: 700 });
  assert.equal(tail.length, 1);
});

test("refiner input wraps recipe, excerpt, directory and raw prompt in tags", () => {
  const input = buildRefinerInput({
    recipe: "RECIPE",
    excerpt: [{ role: "user", text: "hi there" }, { role: "assistant", text: "hello" }],
    cwd: "C:\proj",
    prompt: "make it pop",
  });
  assert.equal(
    input,
    [
      "<prompt_max_instructions>",
      "RECIPE",
      "</prompt_max_instructions>",
      "",
      "<conversation_excerpt>",
      "[user] hi there",
      "[assistant] hello",
      "</conversation_excerpt>",
      "",
      "<working_directory>C:\proj</working_directory>",
      "",
      "<raw_prompt>",
      "make it pop",
      "</raw_prompt>",
    ].join("\n"),
  );
});

test("an empty excerpt says so instead of leaving an empty tag", () => {
  const input = buildRefinerInput({ recipe: "R", excerpt: [], cwd: "/p", prompt: "x" });
  assert.match(input, /<conversation_excerpt>\n\(start of conversation\)\n<\/conversation_excerpt>/);
});

function fakeDeps(overrides = {}) {
  const calls = { claude: [], rewrites: [], logs: [] };
  const deps = {
    env: {},
    config: { model: "claude-opus-5", effort: "high", minWords: 8, maxTurns: 12, maxCharsPerTurn: 700, timeoutMs: 120000, quiet: false },
    recipe: "RECIPE",
    hookDir: "/skill/hooks",
    readFile: () => transcript,
    runClaude: async (call) => {
      calls.claude.push(call);
      return { code: 0, stdout: "<refined_prompt>\nTask: do the thing properly.\n</refined_prompt>", stderr: "", timedOut: false };
    },
    writeRewrite: (text) => calls.rewrites.push(text),
    log: (line) => calls.logs.push(line),
    now: () => 1000,
    ...overrides,
  };
  return { deps, calls };
}

const payload = { prompt: "make the landing page hero feel more premium please", transcript_path: "/t.jsonl", cwd: "/proj" };

test("a refined prompt comes back as additional context with the execute directive", async () => {
  const { deps, calls } = fakeDeps();
  const { output, reason } = await runHook(payload, deps);
  assert.equal(reason, "refined");
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = output.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^<prompt_max>/);
  assert.match(ctx, /Execute the refined prompt/);
  assert.match(ctx, /<refined_prompt>\nTask: do the thing properly\.\n<\/refined_prompt>/);
  assert.match(ctx, /<\/prompt_max>$/);
  assert.equal(output.systemMessage, "Prompt Max refined this message (0s)");
  assert.equal(calls.rewrites.length, 1);
  assert.match(calls.rewrites[0], /make the landing page hero feel more premium please/);
  assert.match(calls.rewrites[0], /Task: do the thing properly\./);
});

test("the child is a tool-less, hook-less, MCP-less headless session on the configured model", async () => {
  const { deps, calls } = fakeDeps();
  await runHook(payload, deps);
  const [call] = calls.claude;
  const args = call.args.join(" ");
  assert.match(args, /^-p /);
  assert.match(args, /--model claude-opus-5/);
  assert.match(args, /--effort high/);
  assert.match(args, /--output-format text/);
  assert.match(args, /--no-session-persistence/);
  assert.match(args, /--settings \/skill\/hooks\/child-settings\.json/);
  assert.match(args, /--strict-mcp-config --mcp-config \/skill\/hooks\/no-mcp\.json/);
  assert.match(args, /--append-system-prompt You are Prompt Max/);
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
  assert.equal(call.env.PROMPT_MAX_CHILD, "1");
  assert.equal(call.timeoutMs, 120000);
  assert.equal(call.cwd, "/proj");
  assert.match(call.input, /<prompt_max_instructions>\nRECIPE\n/);
  assert.match(call.input, /\[user\] make the footer match the header/);
  assert.match(call.input, /<raw_prompt>\nmake the landing page hero feel more premium please\n<\/raw_prompt>/);
});

test("a skipped prompt never spawns the child", async () => {
  const { deps, calls } = fakeDeps();
  const { output, reason } = await runHook({ ...payload, prompt: "yes go" }, deps);
  assert.equal(output, null);
  assert.equal(reason, "short");
  assert.equal(calls.claude.length, 0);
});

test("PASS from the refiner lets the raw prompt through", async () => {
  const { deps } = fakeDeps({ runClaude: async () => ({ code: 0, stdout: "PASS\n", stderr: "", timedOut: false }) });
  const { output, reason } = await runHook(payload, deps);
  assert.equal(output, null);
  assert.equal(reason, "pass");
});

test("a reply without the refined_prompt tag lets the raw prompt through", async () => {
  const { deps, calls } = fakeDeps({ runClaude: async () => ({ code: 0, stdout: "Here is a better prompt: ...", stderr: "", timedOut: false }) });
  const { output, reason } = await runHook(payload, deps);
  assert.equal(output, null);
  assert.equal(reason, "no-refined-prompt");
  assert.equal(calls.rewrites.length, 0);
});

test("an empty refined_prompt lets the raw prompt through", async () => {
  const { deps } = fakeDeps({ runClaude: async () => ({ code: 0, stdout: "<refined_prompt>\n  \n</refined_prompt>", stderr: "", timedOut: false }) });
  const { reason } = await runHook(payload, deps);
  assert.equal(reason, "no-refined-prompt");
});

test("a failing child lets the raw prompt through and is logged", async () => {
  const { deps, calls } = fakeDeps({ runClaude: async () => ({ code: 1, stdout: "", stderr: "Not logged in", timedOut: false }) });
  const { output, reason } = await runHook(payload, deps);
  assert.equal(output, null);
  assert.equal(reason, "child-failed");
  assert.match(calls.logs.join("\n"), /Not logged in/);
});

test("a timed-out child lets the raw prompt through", async () => {
  const { deps } = fakeDeps({ runClaude: async () => ({ code: null, stdout: "", stderr: "", timedOut: true }) });
  const { reason } = await runHook(payload, deps);
  assert.equal(reason, "timeout");
});

test("a thrown error lets the raw prompt through", async () => {
  const { deps, calls } = fakeDeps({ runClaude: async () => { throw new Error("spawn ENOENT"); } });
  const { output, reason } = await runHook(payload, deps);
  assert.equal(output, null);
  assert.equal(reason, "error");
  assert.match(calls.logs.join("\n"), /ENOENT/);
});

test("quiet mode drops the status line", async () => {
  const { deps } = fakeDeps();
  deps.config.quiet = true;
  const { output } = await runHook(payload, deps);
  assert.equal(output.systemMessage, undefined);
});

test("an unreadable transcript still refines, with an empty excerpt", async () => {
  const { deps, calls } = fakeDeps({ readFile: () => null });
  const { reason } = await runHook(payload, deps);
  assert.equal(reason, "refined");
  assert.match(calls.claude[0].input, /\(start of conversation\)/);
});

test("every run leaves one log line with the reason", async () => {
  const { deps, calls } = fakeDeps();
  await runHook(payload, deps);
  await runHook({ ...payload, prompt: "/help" }, deps);
  assert.equal(calls.logs.length, 2);
  assert.match(calls.logs[0], /refined/);
  assert.match(calls.logs[1], /slash-command/);
});
