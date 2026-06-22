import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillRegistry } from '../skill-registry.js';

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

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const step = 25;
  let waited = 0;
  while (!cond() && waited < timeoutMs) {
    await new Promise((r) => setTimeout(r, step));
    waited += step;
  }
  if (!cond()) throw new Error('condition not met within timeout');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-reg-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createSkillRegistry', () => {
  it('loads skills present at creation', () => {
    writeSkill('alpha');
    const reg = createSkillRegistry(root, { watch: false });
    expect(reg.get('alpha')?.name).toBe('alpha');
    expect(reg.list().map((s) => s.name)).toEqual(['alpha']);
    reg.close();
  });

  it('returns undefined for an unknown skill', () => {
    const reg = createSkillRegistry(root, { watch: false });
    expect(reg.get('nope')).toBeUndefined();
    reg.close();
  });

  it('reload() picks up an added skill', () => {
    const reg = createSkillRegistry(root, { watch: false });
    expect(reg.get('beta')).toBeUndefined();
    writeSkill('beta');
    reg.reload();
    expect(reg.get('beta')?.name).toBe('beta');
    reg.close();
  });

  it('reload() drops a removed skill', () => {
    writeSkill('gamma');
    const reg = createSkillRegistry(root, { watch: false });
    expect(reg.get('gamma')).toBeDefined();
    rmSync(join(root, 'gamma'), { recursive: true, force: true });
    reg.reload();
    expect(reg.get('gamma')).toBeUndefined();
    reg.close();
  });

  it('reload() drops a skill toggled to enabled: false', () => {
    writeSkill('delta');
    const reg = createSkillRegistry(root, { watch: false });
    expect(reg.get('delta')).toBeDefined();
    writeSkill('delta', 'enabled: false\n');
    reg.reload();
    expect(reg.get('delta')).toBeUndefined();
    reg.close();
  });

  it('auto-reloads when a skill is added while watching', async () => {
    const reg = createSkillRegistry(root, { debounceMs: 20 });
    expect(reg.get('epsilon')).toBeUndefined();
    writeSkill('epsilon');
    await waitFor(() => reg.get('epsilon') !== undefined, 3000);
    expect(reg.get('epsilon')?.name).toBe('epsilon');
    reg.close();
  });

  it('auto-reloads when a .mcp.json is added to a live skill', async () => {
    writeSkill('zeta');
    const reg = createSkillRegistry(root, { debounceMs: 20 });
    expect(reg.get('zeta')?.mcpServers).toBeUndefined();
    writeFileSync(
      join(root, 'zeta', '.mcp.json'),
      JSON.stringify({ mcpServers: { db: { type: 'http', url: 'http://db' } } }),
    );
    await waitFor(() => reg.get('zeta')?.mcpServers !== undefined, 3000);
    expect(reg.get('zeta')?.mcpServers).toEqual({ db: { type: 'http', url: 'http://db' } });
    reg.close();
  });
});
