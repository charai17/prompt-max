#!/usr/bin/env node
// Prompt Max installer.
//   node install.mjs             copy the skill into ~/.claude/skills/prompt-max and register the hook
//   node install.mjs --uninstall remove the hook entry and the skill folder
// Idempotent: run it again after `git pull` to update.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "./hooks/refine.mjs";

const SKILL_FILES = ["SKILL.md", "prompt.md", "README.md", "LICENSE", "hooks/refine.mjs", "hooks/child-settings.json", "hooks/no-mcp.json"];
const HOOK_MARK = "prompt-max/hooks/refine.mjs";
const HOOK_TIMEOUT_SECONDS = 150;

export function install({ home, source, node }) {
  const skillDir = join(home, ".claude", "skills", "prompt-max");
  mkdirSync(join(skillDir, "hooks"), { recursive: true });
  for (const file of SKILL_FILES) {
    const from = join(source, file);
    if (existsSync(from)) copyFileSync(from, join(skillDir, file));
  }
  const config = join(skillDir, "config.json");
  if (!existsSync(config)) writeFileSync(config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");

  const script = join(skillDir, "hooks", "refine.mjs").replace(/\\/g, "/");
  const entry = {
    type: "command",
    command: `"${node}" "${script}"`,
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: "Prompt Max is refining your message",
  };
  updateSettings(home, (settings) => {
    const hooks = (settings.hooks ??= {});
    const groups = withoutPromptMax(hooks.UserPromptSubmit ?? []);
    hooks.UserPromptSubmit = [...groups, { hooks: [entry] }];
  });
  return { skillDir, command: entry.command };
}

export function uninstall({ home }) {
  const skillDir = join(home, ".claude", "skills", "prompt-max");
  rmSync(skillDir, { recursive: true, force: true });
  if (!existsSync(settingsPath(home))) return;
  updateSettings(home, (settings) => {
    if (!settings.hooks?.UserPromptSubmit) return;
    const groups = withoutPromptMax(settings.hooks.UserPromptSubmit);
    if (groups.length) settings.hooks.UserPromptSubmit = groups;
    else delete settings.hooks.UserPromptSubmit;
  });
}

function withoutPromptMax(groups) {
  return groups
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !String(h.command ?? "").includes(HOOK_MARK)) }))
    .filter((group) => group.hooks.length > 0);
}

function settingsPath(home) {
  return join(home, ".claude", "settings.json");
}

function updateSettings(home, mutate) {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (existsSync(path)) cpSync(path, `${path}.prompt-max.bak`);
  mutate(settings);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const home = homedir();
  if (process.argv.includes("--uninstall")) {
    uninstall({ home });
    console.log("Prompt Max removed. Restart Claude Code to drop the hook.");
  } else {
    const { skillDir, command } = install({ home, source: dirname(fileURLToPath(import.meta.url)), node: process.execPath.replace(/\\/g, "/") });
    console.log(`Prompt Max installed to ${skillDir}`);
    console.log(`Hook: ${command}`);
    console.log("Restart Claude Code (or start a new session) and every message you send will be refined first.");
    console.log("Tune it in config.json next to the skill; PROMPT_MAX_OFF=1 turns it off for a session.");
  }
}
