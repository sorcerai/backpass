import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { alwaysLoadedSkillTokens, pluginSkillLayer } from "../src/plugin-skills.js";
import { loadProjectSkills } from "../src/skills.js";
import { estimateTokens } from "../src/tokens.js";

/** A fake `~/.claude` tree: settings.json + plugins/installed_plugins.json + install dirs. */
function fakeHome({ enabled = {}, plugins = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-plugins-"));
  const claude = path.join(home, ".claude");
  fs.mkdirSync(path.join(claude, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify({ enabledPlugins: enabled }));
  const record = {};
  for (const [key, installs] of Object.entries(plugins)) {
    record[key] = installs.map((install) => {
      const root = path.join(claude, "plugins", "cache", `${key.replace(/[@/]/g, "_")}-${install.version}`);
      for (const [name, description] of Object.entries(install.skills || {})) {
        const dir = path.join(root, "skills", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
        );
      }
      return { scope: "user", installPath: root, version: install.version, lastUpdated: install.lastUpdated ?? 0 };
    });
  }
  fs.writeFileSync(
    path.join(claude, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: record }),
  );
  return home;
}

test("an enabled plugin's skill descriptions count toward the always-loaded surface", () => {
  const home = fakeHome({
    enabled: { "superpowers@official": true },
    plugins: {
      "superpowers@official": [{ version: "1.0.0", skills: { brainstorming: "Use when starting a new design." } }],
    },
  });
  const layer = pluginSkillLayer(home);
  assert.equal(layer.skills.length, 1);
  assert.equal(layer.skills[0].name, "brainstorming");
  assert.equal(layer.skills[0].plugin, "superpowers@official");
  assert.equal(layer.tokens, estimateTokens("Use when starting a new design."));
  assert.deepEqual(layer.warnings, []);
});

test("a disabled or non-boolean-enabled plugin contributes nothing", () => {
  const home = fakeHome({
    enabled: { "off@m": false, "stringy@m": "true", "on@m": true },
    plugins: {
      "off@m": [{ version: "1", skills: { a: "Description A that is quite long indeed." } }],
      "stringy@m": [{ version: "1", skills: { b: "Description B that is quite long indeed." } }],
      "on@m": [{ version: "1", skills: { c: "Description C." } }],
    },
  });
  const layer = pluginSkillLayer(home);
  assert.deepEqual(
    layer.skills.map((s) => s.name),
    ["c"],
  );
});

test("a plugin installed twice is counted once, from the most recently updated install", () => {
  const home = fakeHome({
    enabled: { "dup@m": true },
    plugins: {
      "dup@m": [
        { version: "1.0.0", lastUpdated: 100, skills: { old: "Stale description from the older install." } },
        { version: "2.0.0", lastUpdated: 200, skills: { fresh: "Current description." } },
      ],
    },
  });
  const layer = pluginSkillLayer(home);
  assert.deepEqual(
    layer.skills.map((s) => s.name),
    ["fresh"],
  );
  assert.equal(layer.tokens, estimateTokens("Current description."));
});

test("the same skill name enabled from two marketplaces is counted for each", () => {
  const home = fakeHome({
    enabled: { "frontend-design@a": true, "frontend-design@b": true },
    plugins: {
      "frontend-design@a": [{ version: "1", skills: { "frontend-design": "Use when building UI." } }],
      "frontend-design@b": [{ version: "1", skills: { "frontend-design": "Use when building UI." } }],
    },
  });
  const layer = pluginSkillLayer(home);
  assert.equal(layer.skills.length, 2);
  assert.equal(layer.tokens, estimateTokens("Use when building UI.") * 2);
});

test("a missing or malformed plugin store yields zero tokens and a warning, never a throw", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "backpass-plugins-none-"));
  const missing = pluginSkillLayer(empty);
  assert.equal(missing.tokens, 0);
  assert.deepEqual(missing.skills, []);
  assert.deepEqual(missing.warnings, []);

  const home = fakeHome({ enabled: { "x@m": true }, plugins: {} });
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), "{not json");
  const broken = pluginSkillLayer(home);
  assert.equal(broken.tokens, 0);
  assert.equal(broken.warnings.length, 1);
  assert.match(broken.warnings[0], /installed_plugins\.json/);
});

test("an enabled plugin whose install path is gone is skipped without throwing", () => {
  const home = fakeHome({
    enabled: { "gone@m": true },
    plugins: { "gone@m": [{ version: "1", skills: { a: "Description." } }] },
  });
  fs.rmSync(path.join(home, ".claude", "plugins", "cache"), { recursive: true, force: true });
  const layer = pluginSkillLayer(home);
  assert.equal(layer.tokens, 0);
  assert.deepEqual(layer.skills, []);
});

test("plugin skills are never loaded as editable project skills", () => {
  const home = fakeHome({
    enabled: { "superpowers@official": true },
    plugins: { "superpowers@official": [{ version: "1", skills: { brainstorming: "Use when designing." } }] },
  });
  const skills = loadProjectSkills(home, ".claude/skills", [".agents/skills", ".claude/skills"], { exact: true });
  assert.deepEqual(skills, []);
});

test("alwaysLoadedSkillTokens adds the plugin layer in user scope only", () => {
  const home = fakeHome({
    enabled: { "p@m": true },
    plugins: { "p@m": [{ version: "1", skills: { s: "Use when doing the thing." } }] },
  });
  const own = [{ name: "own", description: "Own skill description." }];
  const ownTokens = estimateTokens("Own skill description.");
  const pluginTokens = estimateTokens("Use when doing the thing.");

  assert.equal(alwaysLoadedSkillTokens(own, { userScope: true, repoRoot: home }), ownTokens + pluginTokens);
  assert.equal(alwaysLoadedSkillTokens(own, { userScope: false, repoRoot: home }), ownTokens);
  assert.equal(alwaysLoadedSkillTokens(own, {}), ownTokens);
});
