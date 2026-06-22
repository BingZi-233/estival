import type { SkillConfig, SkillParam, SkillRequest } from './types.js';

export type ValidationResult = { ok: true } | { ok: false; error: string };

function typeMatches(param: SkillParam, value: unknown): boolean {
  switch (param.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
  }
}

/**
 * Validate a request body against a skill's declared params.
 * - Required params must be present and, for strings, non-empty.
 * - Any declared param that is present must match its declared type.
 * Undeclared extra fields are ignored (they are simply not forwarded as typed params).
 */
export function validateParams(skill: SkillConfig, body: SkillRequest): ValidationResult {
  for (const param of skill.params.required) {
    const value = body[param.name];
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      return { ok: false, error: `missing required param: ${param.name}` };
    }
  }

  for (const param of [...skill.params.required, ...skill.params.optional]) {
    const value = body[param.name];
    if (value === undefined || value === null) continue;
    if (!typeMatches(param, value)) {
      return { ok: false, error: `param '${param.name}' must be ${param.type}` };
    }
  }

  return { ok: true };
}
