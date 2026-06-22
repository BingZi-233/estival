import { LOG_LEVEL, LOG_FORMAT } from './config.js';

/**
 * Zero-dependency leveled logger. All `src/` logging goes through this so output
 * has a consistent shape and an env-controlled verbosity knob.
 *
 * - `LOG_LEVEL` (debug<info<warn<error) drops anything below the threshold.
 * - `LOG_FORMAT=text` (default) emits `<ISO> <LEVEL> [scope] <msg> k=v …`;
 *   `LOG_FORMAT=json` emits one JSON object per line for machine collection.
 * - `warn`/`error` go to stderr, `debug`/`info` to stdout.
 *
 * Note: the stdio MCP servers under `mcp/` must NOT use this — their stdout is
 * the MCP protocol stream, so they log to stderr via `console.error` directly.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Resolved once at load. An unknown LOG_LEVEL falls back to `info` rather than
// silencing everything. Tests re-import with a different env via vi.resetModules().
const threshold = ORDER[LOG_LEVEL as LogLevel] ?? ORDER.info;
const asJson = LOG_FORMAT === 'json';

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Derive a logger that merges `bound` into every record (e.g. request id + skill). */
  child(bound: Fields): Logger;
}

/** Errors don't JSON-serialize usefully and stringify to `[object Object]`; keep their message. */
function normalize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? v.message : v;
  }
  return out;
}

function renderText(ts: string, level: LogLevel, scope: string, msg: string, fields: Fields): string {
  let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  for (const [k, v] of Object.entries(fields)) {
    const val = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
    line += ` ${k}=${val}`;
  }
  return line;
}

function emit(level: LogLevel, scope: string, msg: string, fields: Fields): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  const norm = normalize(fields);
  const line = asJson
    ? JSON.stringify({ ts, level, scope, msg, ...norm })
    : renderText(ts, level, scope, msg, norm);
  // warn/error → stderr (survive stdout piping); info/debug → stdout.
  if (level === 'warn' || level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function createLogger(scope: string, bound: Fields = {}): Logger {
  const at = (level: LogLevel) => (msg: string, fields: Fields = {}): void =>
    emit(level, scope, msg, { ...bound, ...fields });
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (extra: Fields) => createLogger(scope, { ...bound, ...extra }),
  };
}

/** Default logger for the HTTP server core. */
export const logger = createLogger('estival');
