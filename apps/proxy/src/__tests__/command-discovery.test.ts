import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { discoverCommands, parseSkillFrontmatter } from "../command-discovery.js";

const TEST_DIR = join(process.cwd(), ".test-command-discovery");

describe("command-discovery", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns REPL builtin commands", async () => {
    const commands = await discoverCommands(TEST_DIR);
    const builtins = commands.filter((c) => c.source === "builtin");
    expect(builtins.length).toBeGreaterThan(0);
    const names = builtins.map((c) => c.name);
    expect(names).toContain("/compact");
    expect(names).toContain("/help");
    expect(names).toContain("/status");
    expect(names).toContain("/cost");
  });

  it("scans user-level skills from ~/.claude/skills/*/SKILL.md", async () => {
    const userSkillsDir = join(TEST_DIR, ".claude-home", ".claude", "skills", "my-skill");
    mkdirSync(userSkillsDir, { recursive: true });
    writeFileSync(
      join(userSkillsDir, "SKILL.md"),
      `---
name: my-skill
description: A custom skill
argument-hint: some hint
---
# My Skill
Details here.
`,
    );

    const commands = await discoverCommands(TEST_DIR, {
      homeDir: join(TEST_DIR, ".claude-home"),
    });
    const skill = commands.find((c) => c.name === "/my-skill");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("user-skill");
    expect(skill!.description).toBe("A custom skill");
    expect(skill!.argumentHint).toBe("some hint");
  });

  it("scans project-level skills from {workDir}/.claude/skills/*/SKILL.md", async () => {
    const projSkillsDir = join(TEST_DIR, ".claude", "skills", "proj-skill");
    mkdirSync(projSkillsDir, { recursive: true });
    writeFileSync(
      join(projSkillsDir, "SKILL.md"),
      `---
name: proj-skill
description: Project skill
---
# Project Skill
`,
    );

    const commands = await discoverCommands(TEST_DIR);
    const skill = commands.find((c) => c.name === "/proj-skill");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("project-skill");
    expect(skill!.description).toBe("Project skill");
  });

  it("scans user-level commands from ~/.claude/commands/*.md", async () => {
    const userCmdsDir = join(TEST_DIR, ".claude-home", ".claude", "commands");
    mkdirSync(userCmdsDir, { recursive: true });
    writeFileSync(
      join(userCmdsDir, "deploy.md"),
      `Deploy the application to production.

More details here.
`,
    );

    const commands = await discoverCommands(TEST_DIR, {
      homeDir: join(TEST_DIR, ".claude-home"),
    });
    const cmd = commands.find((c) => c.name === "/deploy");
    expect(cmd).toBeDefined();
    expect(cmd!.source).toBe("user-command");
    expect(cmd!.description).toBe("Deploy the application to production.");
  });

  it("scans project-level commands from {workDir}/.claude/commands/*.md", async () => {
    const projCmdsDir = join(TEST_DIR, ".claude", "commands");
    mkdirSync(projCmdsDir, { recursive: true });
    writeFileSync(
      join(projCmdsDir, "test-all.md"),
      `Run all project tests.
`,
    );

    const commands = await discoverCommands(TEST_DIR);
    const cmd = commands.find((c) => c.name === "/test-all");
    expect(cmd).toBeDefined();
    expect(cmd!.source).toBe("project-command");
    expect(cmd!.description).toBe("Run all project tests.");
  });

  it("filters blacklisted commands", async () => {
    const commands = await discoverCommands(TEST_DIR);
    const names = commands.map((c) => c.name);
    expect(names).not.toContain("/login");
    expect(names).not.toContain("/logout");
    expect(names).not.toContain("/config");
    expect(names).not.toContain("/plugin");
    expect(names).not.toContain("/mcp");
    expect(names).not.toContain("/install");
    expect(names).not.toContain("/setup-token");
    expect(names).not.toContain("/doctor");
    expect(names).not.toContain("/update");
    expect(names).not.toContain("/upgrade");
  });

  it("handles missing directories gracefully", async () => {
    const nonExistentDir = join(TEST_DIR, "non-existent");
    const commands = await discoverCommands(nonExistentDir);
    // should still return at least builtins without throwing
    expect(commands.length).toBeGreaterThan(0);
    const builtins = commands.filter((c) => c.source === "builtin");
    expect(builtins.length).toBeGreaterThan(0);
  });

  describe("parseSkillFrontmatter", () => {
    it("extracts name, description, argument-hint from YAML frontmatter", () => {
      const content = `---
name: test-skill
description: A test skill for testing
argument-hint: filename
---
# Test Skill
Body here.
`;
      const result = parseSkillFrontmatter(content);
      expect(result.name).toBe("test-skill");
      expect(result.description).toBe("A test skill for testing");
      expect(result.argumentHint).toBe("filename");
    });

    it("returns partial result when fields are missing", () => {
      const content = `---
name: partial-skill
---
# Partial
`;
      const result = parseSkillFrontmatter(content);
      expect(result.name).toBe("partial-skill");
      expect(result.description).toBeUndefined();
      expect(result.argumentHint).toBeUndefined();
    });

    it("returns empty result for content without frontmatter", () => {
      const content = `# No Frontmatter
Just a body.
`;
      const result = parseSkillFrontmatter(content);
      expect(result.name).toBeUndefined();
      expect(result.description).toBeUndefined();
    });
  });
});
