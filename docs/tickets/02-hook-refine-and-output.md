# 02: Hook runs the refiner and emits the hook JSON

**What to build:** With an injected `spawn`, `refine()` runs the child, extracts `<refined_prompt>`, and returns the `UserPromptSubmit` JSON (additionalContext + systemMessage) or nothing on PASS / failure / timeout. `main()` wires stdin to stdout and always exits 0. Logs are written.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Child is invoked with the agreed flags, `PROMPT_MAX_CHILD=1`, and the recipe+payload on stdin
- [ ] Missing tag, empty body, `PASS`, non-zero exit and timeout all yield no output and a log line
- [ ] Successful run writes `last-rewrite.md` and the JSON with the execute-directive
