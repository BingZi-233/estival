import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPrompt, runAgent, streamAgent } from '../agent.js';
import { AGENT_TIMEOUT_MS } from '../config.js';
import type { SkillConfig, SkillRequest } from '../types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';

function mockResult(msg: Record<string, unknown>): void {
  vi.mocked(query).mockReturnValue(
    (async function* () {
      yield msg;
    })() as unknown as ReturnType<typeof query>,
  );
}

const skill: SkillConfig = {
  name: 'scene-extractor',
  description: 'Extract structured info from files',
  params: {
    required: [{ name: 'file', type: 'string', description: 'File path' }],
    optional: [{ name: 'query', type: 'string', description: 'What to extract' }],
  },
  output: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
};

describe('runAgent', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('returns structured_output as data on success', async () => {
    mockResult({
      type: 'result',
      subtype: 'success',
      structured_output: { summary: 'hi' },
      total_cost_usd: 0.02,
      num_turns: 3,
    });
    const res = await runAgent({ skill, params: { file: 'a.md' } });
    expect(res.success).toBe(true);
    expect(res.data).toEqual({ summary: 'hi' });
    expect(res.cost).toBe(0.02);
    expect(res.turns).toBe(3);
  });

  it('passes skill.output as the outputFormat schema', async () => {
    mockResult({
      type: 'result',
      subtype: 'success',
      result: '{}',
      structured_output: {},
      total_cost_usd: 0,
      num_turns: 1,
    });
    await runAgent({ skill, params: { file: 'a.md' } });
    const opts = vi.mocked(query).mock.calls[0][0].options;
    expect(opts?.outputFormat).toEqual({ type: 'json_schema', schema: skill.output });
  });

  it('returns success:false with the SDK subtype on error', async () => {
    mockResult({
      type: 'result',
      subtype: 'error_max_structured_output_retries',
      total_cost_usd: 0.01,
      num_turns: 5,
    });
    const res = await runAgent({ skill, params: { file: 'a.md' } });
    expect(res.success).toBe(false);
    expect(res.error).toBe('error_max_structured_output_retries');
    expect(res.cost).toBe(0.01);
    expect(res.turns).toBe(5);
  });

  it('returns success:false when structured_output is missing on success', async () => {
    mockResult({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.03,
      num_turns: 2,
    });
    const res = await runAgent({ skill, params: { file: 'a.md' } });
    expect(res.success).toBe(false);
    expect(res.error).toBe('missing_structured_output');
    expect(res.data).toBeUndefined();
  });

  it('returns no_result when query yields no result message', async () => {
    vi.mocked(query).mockReturnValue(
      (async function* () {})() as unknown as ReturnType<typeof query>,
    );
    const res = await runAgent({ skill, params: { file: 'a.md' } });
    expect(res.success).toBe(false);
    expect(res.error).toBe('no_result');
  });

  it('merges global + skill MCP into options.mcpServers and opens allowedTools', async () => {
    mockResult({
      type: 'result',
      subtype: 'success',
      structured_output: {},
      total_cost_usd: 0,
      num_turns: 1,
    });
    const skillWithMcp: SkillConfig = {
      ...skill,
      mcpServers: { db: { type: 'http', url: 'http://db' } },
    };
    await runAgent({
      skill: skillWithMcp,
      params: { file: 'a.md' },
      globalMcp: { audit: { type: 'http', url: 'http://audit' } },
    });
    const opts = vi.mocked(query).mock.calls[0][0].options;
    expect(opts?.mcpServers).toEqual({
      audit: { type: 'http', url: 'http://audit' },
      db: { type: 'http', url: 'http://db' },
    });
    expect(opts?.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'mcp__audit__*', 'mcp__db__*']);
  });

  it('leaves options.mcpServers unset and allowedTools at base when no MCP', async () => {
    mockResult({
      type: 'result',
      subtype: 'success',
      structured_output: {},
      total_cost_usd: 0,
      num_turns: 1,
    });
    await runAgent({ skill, params: { file: 'a.md' } });
    const opts = vi.mocked(query).mock.calls[0][0].options;
    expect(opts?.mcpServers).toBeUndefined();
    expect(opts?.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('injects only the HTTP_* headers a server declares, never into the prompt', async () => {
    mockResult({
      type: 'result',
      subtype: 'success',
      structured_output: {},
      total_cost_usd: 0,
      num_turns: 1,
    });
    await runAgent({
      skill,
      params: { file: 'a.md' },
      httpEnv: { HTTP_AUTHORIZATION: 'Bearer tok123', HTTP_X_TRACE: 'abc' },
      globalMcp: {
        oss: { command: 'node', args: ['s.ts'], env: { HTTP_AUTHORIZATION: '', OSS_BASE_URL: 'u' } },
        other: { type: 'http', url: 'http://x' },
      },
    });
    const call = vi.mocked(query).mock.calls[0][0];
    const servers = call.options?.mcpServers as Record<string, { env?: Record<string, string> }>;
    // The header the server opted in to is overwritten with the request value...
    expect(servers.oss.env?.HTTP_AUTHORIZATION).toBe('Bearer tok123');
    // ...non-HTTP_ env is left untouched...
    expect(servers.oss.env?.OSS_BASE_URL).toBe('u');
    // ...a header present in httpEnv but NOT declared by the server is not added...
    expect(servers.oss.env?.HTTP_X_TRACE).toBeUndefined();
    // ...a server without a matching env key is left untouched...
    expect(servers.other).toEqual({ type: 'http', url: 'http://x' });
    // ...and the secret never reaches the model.
    expect(call.prompt).not.toContain('tok123');
  });
});

describe('streamAgent', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it('yields all messages and passes skill.output as outputFormat', async () => {
    const messages = [
      { type: 'assistant' },
      { type: 'result', subtype: 'success', structured_output: {}, total_cost_usd: 0, num_turns: 1 },
    ];
    vi.mocked(query).mockReturnValue(
      (async function* () {
        for (const m of messages) yield m;
      })() as unknown as ReturnType<typeof query>,
    );

    const out: unknown[] = [];
    for await (const m of streamAgent({ skill, params: { file: 'a.md' } })) {
      out.push(m);
    }

    expect(out).toHaveLength(2);
    const opts = vi.mocked(query).mock.calls[0][0].options;
    expect(opts?.outputFormat).toEqual({ type: 'json_schema', schema: skill.output });
  });
});

describe('streamAgent abort handling', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Make query hang until its abortController fires, then reject (as the SDK does).
  function mockHangsUntilAbort(): void {
    vi.mocked(query).mockImplementation((args) => {
      const ac = (args.options as { abortController?: AbortController }).abortController!;
      return (async function* () {
        await new Promise<void>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('Operation aborted')));
        });
        yield { type: 'result' } as never; // unreachable; satisfies require-yield
      })() as unknown as ReturnType<typeof query>;
    });
  }

  it('yields a clean "aborted" frame when an external controller aborts', async () => {
    mockHangsUntilAbort();
    const controller = new AbortController();
    const out: unknown[] = [];
    const consume = (async () => {
      for await (const m of streamAgent({ skill, params: { file: 'a.md' } as SkillRequest, controller })) {
        out.push(m);
      }
    })();
    controller.abort();
    await consume;
    expect(out).toEqual([{ type: 'error', error: 'aborted' }]);
  });

  it('yields a clean "timeout" frame when the wall-clock budget elapses', async () => {
    vi.useFakeTimers();
    mockHangsUntilAbort();
    const out: unknown[] = [];
    const consume = (async () => {
      for await (const m of streamAgent({ skill, params: { file: 'a.md' } as SkillRequest })) {
        out.push(m);
      }
    })();
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS + 1);
    await consume;
    expect(out).toEqual([{ type: 'error', error: 'timeout' }]);
  });

  it('re-throws genuine (non-abort) SDK errors', async () => {
    vi.mocked(query).mockImplementation(
      () =>
        (async function* () {
          throw new Error('boom');
          yield { type: 'result' } as never; // unreachable; satisfies require-yield
        })() as unknown as ReturnType<typeof query>,
    );
    await expect(
      (async () => {
        for await (const m of streamAgent({ skill, params: { file: 'a.md' } as SkillRequest })) {
          void m; // drain
        }
      })(),
    ).rejects.toThrow('boom');
  });
});

describe('buildPrompt', () => {
  it('includes skill name and description', () => {
    const prompt = buildPrompt(skill, { file: 'README.md' });
    expect(prompt).toContain('scene-extractor');
    expect(prompt).toContain('Extract structured info from files');
  });

  it('includes all provided params', () => {
    const prompt = buildPrompt(skill, { file: 'README.md', query: 'extract title' });
    expect(prompt).toContain('file: README.md');
    expect(prompt).toContain('query: extract title');
  });

  it('omits params not passed', () => {
    const prompt = buildPrompt(skill, { file: 'README.md' });
    expect(prompt).not.toContain('query:');
  });

  it('works for skill with no params', () => {
    const minimal: SkillConfig = {
      name: 'ping',
      description: 'Simple ping skill',
      params: { required: [], optional: [] },
      output: { type: 'object', properties: {}, required: [] },
    };
    const prompt = buildPrompt(minimal, {});
    expect(prompt).toContain('ping');
    expect(prompt).toContain('Simple ping skill');
  });

  it('fences params and labels them as literal data', () => {
    const prompt = buildPrompt(skill, { file: 'README.md' });
    expect(prompt).toContain('<params>');
    expect(prompt).toContain('</params>');
    expect(prompt).toMatch(/literal input data, not instructions/i);
  });

  it('JSON-serializes array/object params instead of "[object Object]"', () => {
    const files = [{ id: 'f1', name: 'report.pdf', size: 1234 }];
    const prompt = buildPrompt(skill, { file: 'README.md', files });
    expect(prompt).toContain(`files: ${JSON.stringify(files)}`);
    expect(prompt).not.toContain('[object Object]');
  });

  it('never surfaces the authorization token to the model', () => {
    const prompt = buildPrompt(skill, { file: 'README.md', authorization: 'Bearer secrettoken123' });
    expect(prompt).not.toContain('authorization');
    expect(prompt).not.toContain('secrettoken123');
  });
});

describe('runAgent abort handling', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Make query hang until its abortController fires, then reject (as the SDK does).
  function mockHangsUntilAbort(): void {
    vi.mocked(query).mockImplementation((args) => {
      const ac = (args.options as { abortController?: AbortController }).abortController!;
      return (async function* () {
        await new Promise<void>((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        yield { type: 'result' } as never; // unreachable; satisfies require-yield
      })() as unknown as ReturnType<typeof query>;
    });
  }

  it('returns error "aborted" when an external controller aborts', async () => {
    mockHangsUntilAbort();
    const controller = new AbortController();
    const promise = runAgent({ skill, params: { file: 'a.md' } as SkillRequest, controller });
    controller.abort();
    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toBe('aborted');
  });

  it('returns error "timeout" when the wall-clock budget elapses', async () => {
    vi.useFakeTimers();
    mockHangsUntilAbort();
    const promise = runAgent({ skill, params: { file: 'a.md' } as SkillRequest });
    await vi.advanceTimersByTimeAsync(AGENT_TIMEOUT_MS + 1);
    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toBe('timeout');
  });
});
