# 01: Hook decides what to skip and builds the refiner input

**What to build:** `hooks/refine.mjs` exposes `shouldSkip`, `transcriptTail` and `buildRefinerInput`; fed a hook payload it either declines (with a reason) or produces the exact text the refiner will receive.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Slash commands, short prompts, the `raw:` prefix, `PROMPT_MAX_OFF` and `PROMPT_MAX_CHILD` all skip with a named reason
- [x] Transcript tail keeps only user/assistant text, newest last, truncated per turn, capped at N turns
- [x] Refiner input wraps instructions, conversation excerpt, cwd and raw prompt in XML tags
