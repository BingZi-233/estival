import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expandEnv, resolveMcpServers, mcpAllowedTools, parseMcpConfig, loadGlobalMcp, loadSkillMcp } from '../mcp.js';

describe('expandEnv', () => {
  it('replaces ${VAR} in strings from the provided env', () => {
    const r = expandEnv('Bearer ${TOKEN}', { TOKEN: 'abc' });
    expect(r).toEqual({ ok: true, value: 'Bearer abc' });
  });

  it('walks nested objects and arrays', () => {
    const r = expandEnv(
      { url: 'http://x', headers: { Authorization: 'Bearer ${TOKEN}' }, args: ['--key=${TOKEN}'] },
      { TOKEN: 'abc' },
    );
    expect(r).toEqual({
      ok: true,
      value: { url: 'http://x', headers: { Authorization: 'Bearer abc' }, args: ['--key=abc'] },
    });
  });

  it('reports the first missing var instead of expanding', () => {
    const r = expandEnv({ headers: { Authorization: 'Bearer ${TOKEN}' } }, {});
    expect(r).toEqual({ ok: false, missing: 'TOKEN' });
  });

  it('leaves non-string leaves untouched', () => {
    const r = expandEnv({ timeout: 5000, alwaysLoad: true }, {});
    expect(r).toEqual({ ok: true, value: { timeout: 5000, alwaysLoad: true } });
  });
});

describe('resolveMcpServers', () => {
  it('merges global and skill servers', () => {
    const merged = resolveMcpServers(
      { a: { type: 'http', url: 'http://a' } },
      { b: { type: 'http', url: 'http://b' } },
    );
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('skill overrides global on same name', () => {
    const merged = resolveMcpServers(
      { a: { type: 'http', url: 'http://global' } },
      { a: { type: 'http', url: 'http://skill' } },
    );
    expect(merged.a).toEqual({ type: 'http', url: 'http://skill' });
  });

  it('handles undefined skill servers', () => {
    const merged = resolveMcpServers({ a: { type: 'http', url: 'http://a' } }, undefined);
    expect(Object.keys(merged)).toEqual(['a']);
  });
});

describe('mcpAllowedTools', () => {
  it('maps each server name to an mcp__<server>__* wildcard', () => {
    expect(mcpAllowedTools({ db: {} as never, api: {} as never }).sort()).toEqual([
      'mcp__api__*',
      'mcp__db__*',
    ]);
  });

  it('returns [] for no servers', () => {
    expect(mcpAllowedTools({})).toEqual([]);
  });
});

describe('parseMcpConfig', () => {
  it('returns servers with valid names', () => {
    const out = parseMcpConfig(
      { mcpServers: { db: { type: 'http', url: 'http://db' } } },
      'test',
      {},
    );
    expect(out).toEqual({ db: { type: 'http', url: 'http://db' } });
  });

  it('expands ${VAR} from env', () => {
    const out = parseMcpConfig(
      { mcpServers: { api: { type: 'http', url: 'http://api', headers: { Auth: '${KEY}' } } } },
      'test',
      { KEY: 'secret' },
    );
    expect(out.api).toEqual({ type: 'http', url: 'http://api', headers: { Auth: 'secret' } });
  });

  it('skips a server whose env var is missing', () => {
    const out = parseMcpConfig(
      { mcpServers: { api: { type: 'http', url: '${MISSING}' } } },
      'test',
      {},
    );
    expect(out).toEqual({});
  });

  it('skips a server with an illegal name', () => {
    const out = parseMcpConfig(
      { mcpServers: { 'bad name': { type: 'http', url: 'http://x' } } },
      'test',
      {},
    );
    expect(out).toEqual({});
  });

  it('returns {} when mcpServers is missing or malformed', () => {
    expect(parseMcpConfig({}, 'test', {})).toEqual({});
    expect(parseMcpConfig({ mcpServers: [] }, 'test', {})).toEqual({});
    expect(parseMcpConfig(null, 'test', {})).toEqual({});
  });
});

const MCP_FIX = join(import.meta.dirname, 'fixtures-mcp');

describe('loadGlobalMcp / loadSkillMcp', () => {
  beforeAll(() => {
    mkdirSync(MCP_FIX, { recursive: true });
    writeFileSync(
      join(MCP_FIX, 'mcp.json'),
      JSON.stringify({ mcpServers: { g: { type: 'http', url: 'http://g' } } }),
    );
    mkdirSync(join(MCP_FIX, 'skill-with-mcp'), { recursive: true });
    writeFileSync(
      join(MCP_FIX, 'skill-with-mcp', '.mcp.json'),
      JSON.stringify({ mcpServers: { s: { type: 'http', url: 'http://s' } } }),
    );
    mkdirSync(join(MCP_FIX, 'skill-bad-json'), { recursive: true });
    writeFileSync(join(MCP_FIX, 'skill-bad-json', '.mcp.json'), '{ not json');
  });

  afterAll(() => {
    rmSync(MCP_FIX, { recursive: true, force: true });
  });

  it('loads a global config file', () => {
    expect(loadGlobalMcp(join(MCP_FIX, 'mcp.json'))).toEqual({
      g: { type: 'http', url: 'http://g' },
    });
  });

  it('returns {} when the global file is absent', () => {
    expect(loadGlobalMcp(join(MCP_FIX, 'nope.json'))).toEqual({});
  });

  it('loads a skill sidecar .mcp.json', () => {
    expect(loadSkillMcp(join(MCP_FIX, 'skill-with-mcp'))).toEqual({
      s: { type: 'http', url: 'http://s' },
    });
  });

  it('returns {} for a skill without a sidecar', () => {
    expect(loadSkillMcp(join(MCP_FIX, 'skill-with-mcp', 'missing'))).toEqual({});
  });

  it('returns {} (no throw) for malformed sidecar JSON', () => {
    expect(loadSkillMcp(join(MCP_FIX, 'skill-bad-json'))).toEqual({});
  });
});
