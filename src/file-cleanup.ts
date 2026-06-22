import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('file-cleanup');

/**
 * Start a periodic sweep that deletes files older than ttlHours from dir.
 * Uses birthtimeMs (fallback mtimeMs) to determine file age.
 * All files in the directory are swept — no prefix/source filtering.
 * Returns a stop function for graceful shutdown.
 */
export function startFileSweep(
  dir: string,
  ttlHours: number,
  intervalMs: number,
): () => void {
  log.info('file sweep started', { dir, ttlHours, intervalMs });

  async function sweep(): Promise<number> {
    const cutoff = Date.now() - ttlHours * 3600_000;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    const results = await Promise.all(
      entries
        .filter((e) => e.isFile())
        .map(async (entry) => {
          const filePath = join(dir, entry.name);
          try {
            const st = await stat(filePath);
            if ((st.birthtimeMs || st.mtimeMs) < cutoff) {
              await unlink(filePath);
              return true;
            }
          } catch {
            // File may have been deleted or is inaccessible — skip.
          }
          return false;
        }),
    );
    const deleted = results.filter(Boolean).length;
    if (deleted > 0) log.info('swept', { deleted, dir });
    return deleted;
  }

  const timer = setInterval(sweep, intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    log.info('file sweep stopped', { dir });
  };
}
