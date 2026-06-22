import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { scanSkills } from './skill-scanner.js';
import { createLogger } from './logger.js';
import type { SkillConfig } from './types.js';

const log = createLogger('skill-registry');

export interface SkillRegistry {
  /** Current config for a skill name, or undefined if not loaded. */
  get(name: string): SkillConfig | undefined;
  /** All currently-loaded skills. */
  list(): SkillConfig[];
  /** Re-scan the skills dir and atomically swap the in-memory map. */
  reload(): void;
  /** Stop all watchers and cancel any pending debounce. */
  close(): void;
}

export interface CreateRegistryOptions {
  /** Enable fs.watch-based auto reload. Default true. */
  watch?: boolean;
  /** Debounce window (ms) coalescing fs events before a reload. Default 200. */
  debounceMs?: number;
}

/**
 * Build a hot-reloading view over a `.claude/skills` directory. On creation it
 * scans once; with `watch` enabled it re-scans (debounced) whenever a skill dir
 * is added/removed or a SKILL.md / .mcp.json under it changes. Reads are served
 * from an in-memory map that is swapped atomically, so in-flight requests that
 * already captured a SkillConfig are unaffected by a reload.
 */
export function createSkillRegistry(
  skillsDir: string,
  opts: CreateRegistryOptions = {},
): SkillRegistry {
  const enableWatch = opts.watch ?? true;
  const debounceMs = opts.debounceMs ?? 200;

  let skills = new Map<string, SkillConfig>();
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function load(): void {
    const next = new Map<string, SkillConfig>();
    for (const s of scanSkills(skillsDir)) next.set(s.name, s);
    skills = next;
  }

  function closeWatchers(): void {
    for (const w of watchers.splice(0)) {
      try {
        w.close();
      } catch {
        // a watched file may already be gone; closing it can throw — ignore.
      }
    }
  }

  function addWatch(path: string): void {
    try {
      const w = watch(path, () => schedule());
      w.on('error', (err) => log.warn('watcher error', { path, err }));
      watchers.push(w);
    } catch (err) {
      log.warn('failed to watch path', { path, err });
    }
  }

  function setupWatchers(): void {
    closeWatchers();
    if (!existsSync(skillsDir)) return;
    // Top-level dir: catches skill subdir add/remove/rename.
    addWatch(skillsDir);
    // Watch each skill subdir → catches SKILL.md edits and .mcp.json add/remove/edit.
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addWatch(join(skillsDir, entry.name));
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      reload();
    }, debounceMs);
    timer.unref();
  }

  function reload(): void {
    load();
    if (enableWatch) setupWatchers();
    log.info('skills reloaded', { skills: [...skills.keys()] });
  }

  // Initial load + watcher setup (no "reloaded" log on first scan).
  load();
  if (enableWatch) setupWatchers();

  return {
    get: (name) => skills.get(name),
    list: () => [...skills.values()],
    reload,
    close() {
      if (timer) clearTimeout(timer);
      // Close watchers last: with no live watchers, no fs event can call schedule() to re-arm the timer.
      closeWatchers();
    },
  };
}
