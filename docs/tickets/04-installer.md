# 04: One-command install and uninstall

**What to build:** `node install.mjs` copies the skill to `~/.claude/skills/prompt-max`, writes default config, registers the hook idempotently with a backup of `settings.json`; `--uninstall` reverses it.

**Blocked by:** 02

**Status:** done

- [x] Install twice against a temp HOME leaves exactly one hook entry
- [x] Uninstall removes the entry and folder, leaves other settings untouched
- [x] Works when `settings.json` is missing or has no `hooks` key
