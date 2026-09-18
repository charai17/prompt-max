# Prompt Max — spec

## Problem Statement

Anton types rough, fast messages into Claude Code. The model acts on them as typed, so it misses context he didn't spell out, guesses at scope, and skips a definition of done. His earlier fix, `/fable`, only worked when he remembered to type it and did the rewrite in-context.

## Solution

Every message he sends passes through a backend refiner before Claude acts on it. A `UserPromptSubmit` hook runs a headless Claude Opus 5 session with the Prompt Max recipe, hands it the raw message plus the recent conversation, and attaches the refined prompt to the turn with a directive to execute the refined version. Short replies and slash commands pass through untouched. The same recipe is available on demand as `/prompt-max <rough prompt>`. The whole thing is a public GitHub repo anyone can install in one command.

## User Stories

1. As Anton, I want my rough message refined before Claude acts, so that Claude works from a complete prompt without me writing one.
2. As Anton, I want short replies ("yes", "the second one", "go") to pass through untouched, so that conversation stays fast.
3. As Anton, I want slash commands to pass through untouched, so that skills keep working.
4. As Anton, I want the refiner to see the recent conversation, so that a follow-up like "now do the same for the footer" is refined correctly.
5. As Anton, I want the refiner to run on Opus 5, so that the refined prompt is as good as possible.
6. As Anton, I want the refined prompt logged to a file, so that a bad run can be inspected.
7. As Anton, I want a one-line status in the transcript when a refinement ran, so that I know the pipeline is on, without seeing the rewrite itself.
8. As Anton, I want the pipeline to fail open, so that a slow or broken refiner never blocks or loses my message.
9. As Anton, I want to turn it off with one environment variable, so that I can compare with and without.
10. As Anton, I want `/prompt-max <rough prompt>` as a manual trigger, so that I can refine in-context when the hook is off.
11. As a GitHub visitor, I want `git clone` + one install command, so that I can use Prompt Max on my own machine (Windows, macOS, Linux).
12. As a GitHub visitor, I want the installer to be idempotent and to offer `--uninstall`, so that my settings.json stays clean.
13. As a GitHub visitor, I want the refiner model, effort, word threshold and quiet mode configurable in a small JSON file, so that I can tune cost and latency.
14. As a GitHub visitor, I want the refiner to never fire its own hooks or MCP servers, so that the pipeline cannot recurse or slow down.
15. As Anton, I want the old `/fable` skill removed, so that only one refiner exists.

## Implementation Decisions

- The repo is the skill: `SKILL.md` (manual trigger), `prompt.md` (the recipe, single source of truth for both hook and skill), `hooks/refine.mjs` (the hook), `install.mjs`, `README.md`. Source lives at `Desktop\CLAUDE\prompt-max`; the installer copies it (no `.git`) to `~/.claude/skills/prompt-max` and registers the hook in `~/.claude/settings.json`.
- Node ≥ 18, zero dependencies, `node --test` for tests. Node is chosen over PowerShell/bash because it is the one runtime Claude Code users reliably have on every platform.
- Hook contract (`UserPromptSubmit`): read stdin JSON (`prompt`, `transcript_path`, `cwd`); decide skip; build the refiner input; spawn `claude -p`; print `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":...},"systemMessage":...}`; always exit 0.
- Skip rules: env `PROMPT_MAX_OFF=1`; env `PROMPT_MAX_CHILD=1` (recursion guard); prompt starts with `/`; fewer than `minWords` words (default 8); prompt starts with `raw:` (explicit bypass; `!` is taken by Claude Code shell mode); refiner returns `PASS`.
- Child session flags: `--model` and `--effort` from config, `--tools ""`, `--output-format text`, `--no-session-persistence`, `--settings hooks/child-settings.json` (`disableAllHooks: true`), `--strict-mcp-config --mcp-config hooks/no-mcp.json`, env `PROMPT_MAX_CHILD=1`. The recipe and payload go through stdin (short argv keeps `.cmd` shims on Windows safe); a one-line `--append-system-prompt` sets the role.
- Conversation excerpt: last `maxTurns` (default 12) user/assistant text entries from the transcript JSONL, each truncated to `maxCharsPerTurn` (default 700), skipping `isMeta`, tool calls, tool results and thinking.
- Refined prompt is extracted from `<refined_prompt>…</refined_prompt>`; if the tag is missing or the body is empty, the run is treated as a failure and the raw prompt proceeds.
- Failure policy: any error or timeout (`timeoutMs`, default 120000) → log, exit 0, no output. The hook's settings timeout is 150 s.
- Logging: `~/.claude/prompt-max/last-rewrite.md` (overwritten) and `~/.claude/prompt-max/runs.log` (append, one line per run).
- Config: `~/.claude/skills/prompt-max/config.json` written by the installer with defaults; env vars `PROMPT_MAX_MODEL`, `PROMPT_MAX_EFFORT`, `PROMPT_MAX_MIN_WORDS`, `PROMPT_MAX_QUIET` override it.
- Installer: `node install.mjs` copies the skill, writes config if absent, adds the hook entry (matched by a `prompt-max` marker in the command) if absent; `--uninstall` removes the entry and the skill folder; always backs up settings.json first.
- Recipe (`prompt.md`) follows Anthropic's published prompting guidance for the Claude 5 family: clear and direct, context and motivation, examples in `<example>` tags, XML structure, tell-what-to-do, scope-is-the-deliverable, assumptions stated, done-definition and verification, at most one blocking question.

## Testing Decisions

- Tests exercise external behaviour of the hook's pure functions and of the orchestrator with an injected fake `spawn`: given stdin JSON → stdout JSON or silence. No test spawns the real `claude`.
- One focused test per stated behaviour, in `hooks/refine.test.mjs`, run with `node --test`.
- Installer tested against a temp HOME: install twice → one hook entry; uninstall → entry gone, other settings intact.
- Manual verification: one real hook run through a live Claude Code session, timing recorded.

## Out of Scope

- Replacing the user's message (hooks cannot). The raw message stays visible; the refined one is executed.
- Refining subagent prompts.
- Any UI beyond the one-line transcript status.

## Further Notes

- Anton's `/fable` skill and its memory file are removed as part of this work; a new memory file records Prompt Max.
