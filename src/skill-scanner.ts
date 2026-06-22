import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { SKILL_NAME_RE } from './config.js';
import { loadSkillMcp } from './mcp.js';
import { createLogger } from './logger.js';
import type { SkillConfig, SkillParam } from './types.js';

const log = createLogger('skill-scanner');

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return (parseYaml(match[1]) as Record<string, unknown>) ?? {};
}

function isSkillParam(val: unknown): val is SkillParam {
  if (typeof val !== 'object' || val === null) return false;
  const v = val as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    (v.type === 'string' || v.type === 'number' || v.type === 'boolean' || v.type === 'array') &&
    typeof v.description === 'string'
  );
}

export function scanSkills(skillsDir: string): SkillConfig[] {
  if (!existsSync(skillsDir)) return [];

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const configs: SkillConfig[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    try {
      const content = readFileSync(skillFile, 'utf-8');
      const data = parseFrontmatter(content);

      // Optional kill-switch: a skill opts out of loading with `enabled: false`.
      // Absent / non-false (incl. true) loads normally — backward compatible.
      if (data.enabled === false) {
        log.info('SKILL.md disabled via enabled:false, skipping', { dir: entry.name });
        continue;
      }

      if (typeof data.name !== 'string' || !data.name) {
        log.warn('SKILL.md missing name, skipping', { dir: entry.name });
        continue;
      }

      // Names become Express route paths — reject anything that could inject
      // path/regex characters or collide with another route.
      if (!SKILL_NAME_RE.test(data.name)) {
        log.warn('SKILL.md invalid name, skipping', {
          dir: entry.name,
          name: data.name,
          mustMatch: String(SKILL_NAME_RE),
        });
        continue;
      }

      if (seen.has(data.name)) {
        log.warn('SKILL.md duplicate name, skipping', { dir: entry.name, name: data.name });
        continue;
      }

      const rawOutput = data.output;
      if (typeof rawOutput !== 'object' || rawOutput === null || Array.isArray(rawOutput)) {
        log.warn('SKILL.md missing or invalid output schema, skipping', { dir: entry.name });
        continue;
      }

      const outputSchema = rawOutput as Record<string, unknown>;
      if (!('type' in outputSchema) && !('properties' in outputSchema)) {
        log.warn("SKILL.md output schema lacks 'type'/'properties', may not be valid JSON schema", {
          dir: entry.name,
        });
      }

      const rawParams = data.params as Record<string, unknown> | undefined;
      const required: SkillParam[] = [];
      const optional: SkillParam[] = [];

      if (rawParams) {
        for (const p of Array.isArray(rawParams.required) ? rawParams.required : []) {
          if (isSkillParam(p)) required.push(p);
        }
        for (const p of Array.isArray(rawParams.optional) ? rawParams.optional : []) {
          if (isSkillParam(p)) optional.push(p);
        }
      }

      seen.add(data.name);
      const mcpServers = loadSkillMcp(join(skillsDir, entry.name));
      configs.push({
        name: data.name,
        description: typeof data.description === 'string' ? data.description : '',
        params: { required, optional },
        output: outputSchema,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      });
    } catch (err) {
      log.warn('failed to parse SKILL.md', { dir: entry.name, err });
    }
  }

  return configs;
}
