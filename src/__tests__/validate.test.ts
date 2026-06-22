import { describe, it, expect } from 'vitest';
import { validateParams } from '../validate.js';
import type { SkillConfig } from '../types.js';

const skill: SkillConfig = {
  name: 'demo',
  description: 'demo',
  params: {
    required: [{ name: 'file', type: 'string', description: 'path' }],
    optional: [
      { name: 'count', type: 'number', description: 'n' },
      { name: 'flag', type: 'boolean', description: 'b' },
    ],
  },
  output: { type: 'object' },
};

describe('validateParams', () => {
  it('passes when required present and types match', () => {
    expect(validateParams(skill, { file: 'a.md', count: 3, flag: true })).toEqual({ ok: true });
  });

  it('passes when only required present', () => {
    expect(validateParams(skill, { file: 'a.md' })).toEqual({ ok: true });
  });

  it('rejects missing required', () => {
    const r = validateParams(skill, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('file');
  });

  it('rejects empty-string required', () => {
    const r = validateParams(skill, { file: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects wrong type on declared param', () => {
    const r = validateParams(skill, { file: 'a.md', count: 'three' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('count');
  });

  it('rejects NaN for number param', () => {
    expect(validateParams(skill, { file: 'a.md', count: NaN }).ok).toBe(false);
  });

  it('ignores undeclared extra fields', () => {
    expect(validateParams(skill, { file: 'a.md', extra: 'x' })).toEqual({ ok: true });
  });
});

describe('validateParams with an array param', () => {
  const arraySkill: SkillConfig = {
    name: 'demo-array',
    description: 'demo',
    params: {
      required: [{ name: 'files', type: 'array', description: '[{id,name,size}]' }],
      optional: [],
    },
    output: { type: 'object' },
  };

  it('passes for a non-empty array', () => {
    expect(validateParams(arraySkill, { files: [{ id: '1', name: 'a.pdf', size: 9 }] })).toEqual({
      ok: true,
    });
  });

  it('rejects an empty array as a missing required param', () => {
    const r = validateParams(arraySkill, { files: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('files');
  });

  it('rejects a non-array value for an array param', () => {
    const r = validateParams(arraySkill, { files: 'a.pdf' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('files');
  });
});
