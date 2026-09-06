/**
 * The read-only skill layer: skills a Claude Code plugin contributes to the
 * always-loaded surface.
 *
 * A plugin skill's `description:` line is loaded on every turn exactly like a
 * repo-authored one, so leaving it out understates the budget the run is tuned
 * against. The files themselves belong to the plugin - the next plugin update
 * overwrites them - so backpass counts them and never proposes an edit to one.
 *
 * They are deliberately invisible to analysis and synthesis too. Showing them
 * would let a run attribute a mistake to a plugin skill and then propose a fix
 * the writer must refuse, which is worse than not seeing them at all. Counting
 * is the whole contract; keep them out of `loadProjectSkills`, staging, and
 * `resolveTarget`.
 *
 * Only a user-scope run counts this layer. In project scope these tokens are
 * user-level and untradeable, so charging a repo for them would push every
 * repo into shrink mode over text a project run cannot touch.
 */
import fs from "node:fs";
import path from "node:path";

import { parseFrontmatter, skillDescriptionTokens } from "./skills.js";
import { estimateTokens } from "./tokens.js";

/** Claude Code's config root, honouring the same `CLAUDE_CONFIG_DIR` relocation config.js uses. */
export function claudeConfigRoot(home) {
  const configured = process.env.CLAUDE_CONFIG_DIR || ".claude";
  return path.isAbsolute(configured) ? configured : path.join(home, configured);
}

function readJson(file, label, warnings) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null; // Absent is the ordinary case: no plugins installed, nothing to warn about.
  }
  try {
    return JSON.parse(text);
  } catch {
    warnings.push(`could not parse ${label}; plugin skills are not counted this run`);
    return null;
  }
}

/**
 * Which install of a twice-installed plugin Claude Code actually activates is not
 * documented. Newest `lastUpdated` is a heuristic pinned by test, in the same posture
 * as the transcript adapters: when the on-disk shape changes, fix this and its test.
 */
function activeInstall(installs) {
  const usable = (Array.isArray(installs) ? installs : []).filter((i) => i && typeof i.installPath === "string");
  if (!usable.length) return null;
  return usable.reduce((best, i) => ((i.lastUpdated ?? 0) > (best.lastUpdated ?? 0) ? i : best));
}

function readPluginSkills(pluginKey, installPath, warnings) {
  const root = path.join(installPath, "skills");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // A plugin with no skills dir, or an install path that is gone.
  }
  const skills = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name, "SKILL.md");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let description;
    try {
      description = String(parseFrontmatter(text).description || "").trim();
    } catch {
      warnings.push(`could not read the description of ${pluginKey}:${entry.name}`);
      continue;
    }
    if (!description) continue;
    skills.push({
      name: entry.name,
      plugin: pluginKey,
      description,
      descriptionTokens: estimateTokens(description),
      path: file,
      readOnly: true,
    });
  }
  return skills;
}

/**
 * Every enabled plugin's skill descriptions. Fail-soft throughout: an unreadable or
 * malformed store warns and contributes zero, never throws, so a plugin the harness
 * cannot read can never fail a run.
 */
export function pluginSkillLayer(home) {
  const warnings = [];
  const root = claudeConfigRoot(home);
  const settings = readJson(path.join(root, "settings.json"), "settings.json", warnings);
  const enabledRaw = settings?.enabledPlugins;
  const enabled =
    enabledRaw && typeof enabledRaw === "object" && !Array.isArray(enabledRaw)
      ? Object.keys(enabledRaw).filter((k) => enabledRaw[k] === true)
      : [];
  if (!enabled.length) return { tokens: 0, skills: [], warnings };

  const store = readJson(path.join(root, "plugins", "installed_plugins.json"), "installed_plugins.json", warnings);
  const installed = store?.plugins;
  if (!installed || typeof installed !== "object") return { tokens: 0, skills: [], warnings };

  const skills = [];
  for (const key of enabled.sort()) {
    const install = activeInstall(installed[key]);
    if (!install) continue;
    skills.push(...readPluginSkills(key, install.installPath, warnings));
  }
  return { tokens: skillDescriptionTokens(skills), skills, warnings };
}

/**
 * The always-loaded skill cost the budget gate measures: this run's editable skill
 * descriptions plus, in user scope, the read-only plugin layer. Every site that
 * compares the surface against `budgetTokens` must call this and not
 * `skillDescriptionTokens`, or the prompt frames one number while a gate enforces
 * another.
 */
export function alwaysLoadedSkillTokens(skills, { userScope = false, repoRoot = null } = {}) {
  const own = skillDescriptionTokens(skills);
  if (!userScope || !repoRoot) return own;
  return own + pluginSkillLayer(repoRoot).tokens;
}
