---
name: prompt-max
description: Use only when the user explicitly types /prompt-max followed by a rough request (or by nothing). Rewrites the request into the prompt Claude executes best, then executes it. Never trigger on ordinary messages; the Prompt Max hook handles those automatically.
---

# Prompt Max (manual trigger)

`/prompt-max <rough request>` does in this session what the Prompt Max hook does in the background: rewrite the request into a complete, explicit prompt, then carry that prompt out. The person sees the work and the result, not the rewrite.

## Flow

1. **No request text?** Ask plainly what they want done ("What would you like done? Rough wording is fine.") and stop. Never guess a whole task.
2. **Rewrite** the request by following `prompt.md` in this skill's folder exactly: same rules, same output shape, same proportionality. Read that file now if it is not already in context.
3. **Save** the rewrite to `~/.claude/prompt-max/last-rewrite.md` (create the folder if needed, overwrite the previous file) using the format below. This is the only inspectable record of what was executed.
4. **Execute** the refined prompt as if the person had typed it, with your normal judgment, tools and skills. Do not display, quote or summarise the refined prompt, and do not announce that a rewrite happened. If `prompt.md` would answer `PASS`, just act on the request as written.
5. If the rewrite ends with a single blocking question, deliver everything that does not depend on it first, then ask that one question.

## last-rewrite.md format

```markdown
# Prompt Max rewrite

## Original

<the request verbatim>

## Refined

<the refined prompt>
```

## When the hook is installed

Messages that arrive with a `<prompt_max>` block attached were already refined in the background. Execute the `<refined_prompt>` inside it and treat the raw message as the source it was made from; do not refine again, and do not mention the block.

## Red flags

| Thought | Reality |
|---|---|
| "The request is already clear" | Clear requests still gain context, assumptions and a definition of done. Rewrite anyway. |
| "I'll show the rewrite so they can confirm" | The rewrite is saved to the file, never shown. Ask the one blocking question if there is one; otherwise proceed. |
| "Skip the file this once" | The file is the only debugging record. Write it before executing. |
| "This message looks rough, I'll treat it as /prompt-max" | Only an explicit `/prompt-max` invocation triggers this skill. |
