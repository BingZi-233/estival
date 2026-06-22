import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The logger reads LOG_LEVEL/LOG_FORMAT from config at import time, so each case
// sets the env and re-imports a fresh module via vi.resetModules().
async function loadLogger(level: string, format: string) {
  process.env.LOG_LEVEL = level;
  process.env.LOG_FORMAT = format;
  vi.resetModules();
  return import('../logger.js');
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
  delete process.env.LOG_FORMAT;
});

describe('logger level threshold', () => {
  it('drops messages below the threshold', async () => {
    const { logger } = await loadLogger('info', 'text');
    logger.debug('hidden');
    expect(logSpy).not.toHaveBeenCalled();
    logger.info('shown');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('emits debug when LOG_LEVEL=debug', async () => {
    const { logger } = await loadLogger('debug', 'text');
    logger.debug('now visible');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to info for an unknown LOG_LEVEL', async () => {
    const { logger } = await loadLogger('bogus', 'text');
    logger.debug('hidden');
    expect(logSpy).not.toHaveBeenCalled();
    logger.info('shown');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe('logger output routing', () => {
  it('sends debug/info to stdout and warn/error to stderr', async () => {
    const { logger } = await loadLogger('debug', 'text');
    logger.debug('d');
    logger.info('i');
    expect(logSpy).toHaveBeenCalledTimes(2);
    logger.warn('w');
    logger.error('e');
    expect(errSpy).toHaveBeenCalledTimes(2);
  });
});

describe('logger text format', () => {
  it('renders level, scope, msg and fields on one line', async () => {
    const { logger } = await loadLogger('info', 'text');
    logger.info('received', { req: 'req#1', paramKeys: ['a', 'b'] });
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain('INFO');
    expect(line).toContain('[estival]');
    expect(line).toContain('received');
    expect(line).toContain('req=req#1');
    expect(line).toContain('paramKeys=["a","b"]');
  });
});

describe('logger json format', () => {
  it('emits one parseable JSON object with level/scope/msg/fields', async () => {
    const { logger } = await loadLogger('info', 'json');
    logger.info('done', { ms: 12, turns: 3 });
    const obj = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(obj).toMatchObject({ level: 'info', scope: 'estival', msg: 'done', ms: 12, turns: 3 });
    expect(typeof obj.ts).toBe('string');
  });

  it('normalizes Error fields to their message', async () => {
    const { logger } = await loadLogger('info', 'json');
    logger.error('boom', { err: new Error('kaboom') });
    const obj = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(obj.err).toBe('kaboom');
  });
});

describe('logger child', () => {
  it('merges bound fields into every record', async () => {
    const { createLogger } = await loadLogger('info', 'json');
    const rlog = createLogger('agent').child({ req: 'req#7', skill: 'jj0016' });
    rlog.info('run', { extra: true });
    const obj = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(obj).toMatchObject({ scope: 'agent', req: 'req#7', skill: 'jj0016', extra: true });
  });
});
