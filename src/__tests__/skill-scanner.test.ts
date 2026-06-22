import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkills } from '../skill-scanner.js';

const FIXTURES = join(import.meta.dirname, 'fixtures-skills');

beforeAll(() => {
  mkdirSync(join(FIXTURES, 'valid-skill'), { recursive: true });
  writeFileSync(
    join(FIXTURES, 'valid-skill', 'SKILL.md'),
    `---
name: valid-skill
description: A valid skill
params:
  required:
    - name: file
      type: string
      description: File path to read
  optional:
    - name: query
      type: string
      description: What to extract
output:
  type: object
  properties:
    title:
      type: string
  required:
    - title
---
# Valid Skill
`,
  );

  mkdirSync(join(FIXTURES, 'no-name'), { recursive: true });
  writeFileSync(
    join(FIXTURES, 'no-name', 'SKILL.md'),
    `---
description: Missing name field
---
# No Name
`,
  );

  mkdirSync(join(FIXTURES, 'no-params'), { recursive: true });
  writeFileSync(
    join(FIXTURES, 'no-params', 'SKILL.md'),
    `---
name: no-params
description: No params block defined
output:
  type: object
  properties:
    ok:
      type: boolean
  required:
    - ok
---
# No Params
`,
  );

  mkdirSync(join(FIXTURES, 'no-output'), { recursive: true });
  writeFileSync(
    join(FIXTURES, 'no-output', 'SKILL.md'),
    `---
name: no-output
description: Missing output schema
params:
  required:
    - name: file
      type: string
      description: File path
---
# No Output
`,
  );

  // Invalid name (uppercase + space) — would corrupt the route path.
  mkdirSync(join(FIXTURES, 'bad-name'), { recursive: true });
  writeFileSync(
    join(FIXTURES, 'bad-name', 'SKILL.md'),
    `---
name: Bad Name
description: Illegal route name
output:
  type: object
---
# Bad Name
`,
  );

  // Duplicate of valid-skill's name — second occurrence must be dropped.
  mkdirSync(join(FIXTURES, 'zz-dup'), { recursive: true });
  writeFileSync(
    join(FIXTURES, 'zz-dup', 'SKILL.md'),
    `---
name: valid-skill
description: Duplicate name, should be skipped
output:
  type: object
---
# Dup
`,
  );

  // Skill with a sidecar .mcp.json — its servers must land on config.mcpServers.
  mkdirSync(join(FIXTURES, 'mcp-skill'), { recursive: true });
  writeFileSync(
    join(FIXTURES, 'mcp-skill', 'SKILL.md'),
    `---
name: mcp-skill
description: Skill with MCP
output:
  type: object
  properties:
    ok:
      type: boolean
  required:
    - ok
---
# MCP Skill
`,
  );
  writeFileSync(
    join(FIXTURES, 'mcp-skill', '.mcp.json'),
    JSON.stringify({ mcpServers: { db: { type: 'http', url: 'http://db' } } }),
  );
});

afterAll(() => {
  rmSync(FIXTURES, { recursive: true, force: true });
});

describe('scanSkills', () => {
  it('returns [] for nonexistent directory', () => {
    expect(scanSkills('/nonexistent/path/abc123')).toEqual([]);
  });

  it('parses valid skill with required and optional params', () => {
    const skills = scanSkills(FIXTURES);
    const skill = skills.find((s) => s.name === 'valid-skill');
    expect(skill).toBeDefined();
    expect(skill!.description).toBe('A valid skill');
    expect(skill!.params.required).toHaveLength(1);
    expect(skill!.params.required[0]).toEqual({
      name: 'file',
      type: 'string',
      description: 'File path to read',
    });
    expect(skill!.params.optional[0].name).toBe('query');
    expect(skill!.output).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
  });

  it('skips skill that is missing name field', () => {
    const skills = scanSkills(FIXTURES);
    expect(skills.every((s) => s.name !== '')).toBe(true);
    expect(skills).toHaveLength(3); // valid-skill + no-params + mcp-skill; no-name and no-output skipped
  });

  it('skips skill that is missing output schema (strict)', () => {
    const skills = scanSkills(FIXTURES);
    expect(skills.find((s) => s.name === 'no-output')).toBeUndefined();
  });

  it('returns empty params arrays for skill with no params block', () => {
    const skills = scanSkills(FIXTURES);
    const skill = skills.find((s) => s.name === 'no-params');
    expect(skill).toBeDefined();
    expect(skill!.params.required).toHaveLength(0);
    expect(skill!.params.optional).toHaveLength(0);
  });

  it('skips skill with an invalid name', () => {
    const skills = scanSkills(FIXTURES);
    expect(skills.find((s) => s.name === 'Bad Name')).toBeUndefined();
  });

  it('drops duplicate names, keeping a single entry', () => {
    const skills = scanSkills(FIXTURES);
    const matches = skills.filter((s) => s.name === 'valid-skill');
    expect(matches).toHaveLength(1);
    // First-seen wins: 'valid-skill' dir sorts before 'zz-dup'.
    expect(matches[0].description).toBe('A valid skill');
  });

  it('attaches sidecar .mcp.json servers to the skill config', () => {
    const skills = scanSkills(FIXTURES);
    const skill = skills.find((s) => s.name === 'mcp-skill');
    expect(skill).toBeDefined();
    expect(skill!.mcpServers).toEqual({ db: { type: 'http', url: 'http://db' } });
  });

  it('leaves mcpServers undefined for a skill without a sidecar', () => {
    const skills = scanSkills(FIXTURES);
    const skill = skills.find((s) => s.name === 'valid-skill');
    expect(skill!.mcpServers).toBeUndefined();
  });
});

describe('scanSkills enabled field', () => {
  let root: string;

  function writeSkill(name: string, extraFrontmatter = ''): void {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, 'SKILL.md'),
      `---
name: ${name}
description: ${name} skill
${extraFrontmatter}output:
  type: object
  properties:
    ok:
      type: boolean
  required:
    - ok
---
# ${name}
`,
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-enabled-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads a skill when enabled is absent', () => {
    writeSkill('plain');
    expect(scanSkills(root).map((s) => s.name)).toEqual(['plain']);
  });

  it('loads a skill when enabled: true', () => {
    writeSkill('on', 'enabled: true\n');
    expect(scanSkills(root).map((s) => s.name)).toEqual(['on']);
  });

  it('skips a skill when enabled: false', () => {
    writeSkill('off', 'enabled: false\n');
    expect(scanSkills(root)).toEqual([]);
  });

  it('loads other skills even when one is disabled', () => {
    writeSkill('on');
    writeSkill('off', 'enabled: false\n');
    expect(scanSkills(root).map((s) => s.name).sort()).toEqual(['on']);
  });
});
