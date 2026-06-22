import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('mcp');

export type McpServers = Record<string, McpServerConfig>;

type EnvMap = Record<string, string | undefined>;
type ExpandResult = { ok: true; value: unknown } | { ok: false; missing: string };

const VAR_RE = /\$\{([A-Za-z0-9_]+)\}/g;

/** Replace `${VAR}` in config values against `env`. Returns the first missing
 *  var name instead of expanding, so the caller can drop the server rather than
 *  half-connect with a blank credential. */
export function expandEnv(value: unknown, env: EnvMap = process.env): ExpandResult {
  if (typeof value === 'string') {
    let missing: string | undefined;
    const out = value.replace(VAR_RE, (_, name: string) => {
      const v = env[name];
      if (v === undefined) {
        missing ??= name;
        return '';
      }
      return v;
    });
    return missing ? { ok: false, missing } : { ok: true, value: out };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const r = expandEnv(item, env);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = expandEnv(v, env);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

/** Merge global and per-skill servers; skill wins on name collision. */
export function resolveMcpServers(global: McpServers, skill: McpServers | undefined): McpServers {
  const merged: McpServers = { ...global };
  for (const [name, cfg] of Object.entries(skill ?? {})) {
    if (name in merged) {
      log.warn('skill server overrides a global server of the same name', { server: name });
    }
    merged[name] = cfg;
  }
  return merged;
}

/** Server-level allowlist entry. The Agent SDK only treats `mcp__<server>__*`
 *  (with the trailing `__*` glob) as a wildcard granting every tool of that
 *  server; a bare `mcp__<server>` matches no tool and would be denied under
 *  `permissionMode: 'dontAsk'`. */
export function mcpAllowedTools(servers: McpServers): string[] {
  return Object.keys(servers).map((name) => `mcp__${name}__*`);
}

/** MCP server name: becomes part of the `mcp__<name>` tool prefix, so restrict
 *  to a safe charset to avoid malformed tool identifiers / allowlist mismatch. */
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Parse a standard MCP config object `{ mcpServers: { <name>: <config> } }`.
 *  Drops servers with illegal names or unresolved `${VAR}`. Never throws. */
export function parseMcpConfig(
  raw: unknown,
  source: string,
  env: EnvMap = process.env,
): McpServers {
  if (raw === null || typeof raw !== 'object') {
    log.warn('config is not an object, ignoring', { source });
    return {};
  }
  const servers = (raw as Record<string, unknown>).mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    log.warn("missing or invalid 'mcpServers' object, ignoring", { source });
    return {};
  }
  const out: McpServers = {};
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!SERVER_NAME_RE.test(name)) {
      log.warn('invalid server name, skipping', { source, name });
      continue;
    }
    const expanded = expandEnv(cfg, env);
    if (!expanded.ok) {
      log.warn('server references missing env var, skipping', {
        source,
        server: name,
        missing: expanded.missing,
      });
      continue;
    }
    out[name] = expanded.value as McpServerConfig;
  }
  return out;
}

function loadMcpFile(path: string): McpServers {
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parseMcpConfig(raw, path);
  } catch (err) {
    log.warn('failed to parse mcp file', { path, err });
    return {};
  }
}

/** Load the global MCP config file. Absent file → no global servers. */
export function loadGlobalMcp(path: string): McpServers {
  return loadMcpFile(path);
}

/** Load a skill's sidecar `.mcp.json` (if any) from its directory. */
export function loadSkillMcp(skillDir: string): McpServers {
  return loadMcpFile(join(skillDir, '.mcp.json'));
}
