# Prompt Max

Every message you send to Claude Code gets rewritten into the best possible prompt before Claude acts on it.

You type rough. A background Claude Opus 5 session, primed with the recent conversation and a refinement recipe built from Anthropic's published prompting guidance, turns the message into an explicit brief: task, context, requirements, constraints, assumptions, definition of done. Claude executes the brief. You only see the work.

```
you:     make the landing page better, it looks generic

refined: Task: Make the landing page read as designed rather than generated, keeping its sections, copy and stack.
         Context: …what the conversation already established…
         Requirements: 1. Find the three strongest signals of "generic" … 2. Keep every section …
         Constraints: Leave pricing, claims and legal text unchanged. …
         Assumptions: "Better" means more distinctive, not more features. …
         Done when: The page builds, passes lint and type checks, reads as designed at desktop and phone widths …
```

Short replies ("yes", "the second one"), slash commands and anything under eight words pass straight through, so conversation stays fast. A refinement adds roughly 15–25 seconds on Opus 5.

## Install

Requirements: [Claude Code](https://claude.com/claude-code) signed in, Node 18 or newer, on Windows, macOS or Linux.

```bash
git clone https://github.com/charai17/prompt-max.git
cd prompt-max
node install.mjs
```

Then start a new Claude Code session. That's it. The installer copies the skill to `~/.claude/skills/prompt-max`, writes a default `config.json` there, and adds one `UserPromptSubmit` hook to `~/.claude/settings.json` (a backup is saved next to it as `settings.json.prompt-max.bak`).

Update: `git pull` then `node install.mjs` again. Your edited `config.json` is kept.

Remove: `node install.mjs --uninstall`, then start a new session.

## How it works

1. Claude Code runs `hooks/refine.mjs` before each message reaches the model, passing the message, the transcript path and the working directory.
2. The hook applies the skip rules. If the message qualifies, it reads the last 12 things you and Claude said from the transcript (tool calls and thinking are dropped), and runs a headless `claude -p` on the configured model with the recipe in `prompt.md`, the excerpt and your message. That child session has no tools, no hooks, no MCP servers and no persistence, so it cannot recurse, and it exits after one reply.
3. The child answers with a `<refined_prompt>` block, or `PASS` if the message needs no refining. The hook attaches the block to your turn as additional context with a one-line directive: execute this, it is the person's message made explicit.
4. Anything else (timeout, error, a reply without the block) fails open: your raw message proceeds untouched and the reason is logged.

Every run appends one line to `~/.claude/prompt-max/runs.log`. The most recent rewrite is at `~/.claude/prompt-max/last-rewrite.md`, original and refined side by side. A status line, "Prompt Max refined this message (19s)", appears in the transcript when a refinement ran.

Claude Code hooks cannot replace the message you typed, only add to it. Your raw message stays visible in the conversation; the refined one is what gets executed.

## Manual trigger

`/prompt-max <rough request>` does the same rewrite inside the current session and then executes it. Useful when the hook is off (`PROMPT_MAX_OFF=1`) or if you want the refinement done by the session's own model.

## Configuration

`~/.claude/skills/prompt-max/config.json`:

| Key | Default | What it does |
|---|---|---|
| `model` | `claude-opus-5` | Model the refiner runs on. `claude-sonnet-5` is faster and cheaper. |
| `effort` | `high` | Effort level for the refiner (`low`, `medium`, `high`, `xhigh`, `max`). |
| `minWords` | `8` | Messages with fewer words pass through untouched. |
| `maxTurns` | `12` | How many recent turns the refiner sees. |
| `maxCharsPerTurn` | `700` | Truncation per turn in the excerpt. |
| `timeoutMs` | `120000` | Give up and pass the raw message through after this long. |
| `quiet` | `false` | `true` hides the transcript status line. |

Environment variables override the file for one session: `PROMPT_MAX_OFF=1` (disable), `PROMPT_MAX_MODEL`, `PROMPT_MAX_EFFORT`, `PROMPT_MAX_MIN_WORDS`, `PROMPT_MAX_QUIET`, `PROMPT_MAX_CLAUDE_BIN` (path to the `claude` binary if it is not on your PATH).

Start a message with `!raw` to bypass the refiner for that message only.

## The recipe

`prompt.md` is the whole refiner. It is one file, written for the model, and it is where the quality comes from. It follows the patterns Anthropic documents for the Claude 5 family: be clear and direct, add the context and the reason behind each instruction, structure with XML tags, say what to do rather than what to avoid, state assumptions, define done and how to verify it, keep changes to what was asked, and ask at most one blocking question. Edit it, reinstall, and the next message uses your version.

## Development

```bash
node --test
```

Tests cover the hook's decision logic and output contract with a fake child process, and the installer against a temporary home directory. Nothing in the test suite calls the real `claude`.

Layout: `hooks/refine.mjs` (the hook, pure functions on top and the I/O shell underneath), `prompt.md` (the recipe), `SKILL.md` (the manual trigger), `install.mjs`, `docs/` (spec and tickets).

## Licence

MIT
