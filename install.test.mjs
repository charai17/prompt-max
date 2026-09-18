import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { install, uninstall } from "./install.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const freshHome = () => mkdtempSync(join(tmpdir(), "prompt-max-home-"));
const settingsOf = (home) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
const promptMaxHooks = (settings) =>
  (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) => group.hooks).filter((h) => /prompt-max/.test(h.command));

test("install copies the skill and registers one UserPromptSubmit hook", () => {
  const home = freshHome();
  install({ home, source, node: "/usr/local/bin/node" });

  const skill = join(home, ".claude", "skills", "prompt-max");
  for (const file of ["SKILL.md", "prompt.md", "config.json", "hooks/refine.mjs", "hooks/child-settings.json", "hooks/no-mcp.json"]) {
    assert.ok(existsSync(join(skill, file)), `${file} missing`);
  }
  assert.ok(!existsSync(join(skill, "hooks", "refine.test.mjs")), "tests must not be installed");
  assert.ok(!existsSync(join(skill, "docs")), "docs must not be installed");

  const hooks = promptMaxHooks(settingsOf(home));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].type, "command");
  assert.equal(hooks[0].timeout, 150);
  assert.equal(hooks[0].command, `"/usr/local/bin/node" "${join(skill, "hooks", "refine.mjs").replace(/\\/g, "/")}"`);
  rmSync(home, { recursive: true, force: true });
});

test("installing twice leaves exactly one hook entry", () => {
  const home = freshHome();
  install({ home, source, node: "node" });
  install({ home, source, node: "node" });
  assert.equal(promptMaxHooks(settingsOf(home)).length, 1);
  rmSync(home, { recursive: true, force: true });
});

test("existing settings and hooks survive install and uninstall", () => {
  const home = freshHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  const existing = {
    model: "opus",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo other" }] }] },
  };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(existing));

  install({ home, source, node: "node" });
  let settings = settingsOf(home);
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "echo hi");
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.ok(existsSync(join(home, ".claude", "settings.json.prompt-max.bak")));

  uninstall({ home });
  settings = settingsOf(home);
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "echo hi");
  assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: "echo other" }] }]);
  assert.ok(!existsSync(join(home, ".claude", "skills", "prompt-max")));
  rmSync(home, { recursive: true, force: true });
});

test("uninstall removes an empty UserPromptSubmit key rather than leaving []", () => {
  const home = freshHome();
  install({ home, source, node: "node" });
  uninstall({ home });
  assert.equal(settingsOf(home).hooks.UserPromptSubmit, undefined);
  rmSync(home, { recursive: true, force: true });
});

test("a user's edited config.json is kept on reinstall", () => {
  const home = freshHome();
  install({ home, source, node: "node" });
  const config = join(home, ".claude", "skills", "prompt-max", "config.json");
  writeFileSync(config, JSON.stringify({ model: "claude-sonnet-5" }));
  install({ home, source, node: "node" });
  assert.equal(JSON.parse(readFileSync(config, "utf8")).model, "claude-sonnet-5");
  rmSync(home, { recursive: true, force: true });
});

test("uninstall on a machine that never installed is a no-op", () => {
  const home = freshHome();
  assert.doesNotThrow(() => uninstall({ home }));
  rmSync(home, { recursive: true, force: true });
});
