import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '../config.js';

describe('expandHome', () => {
  it('expands bare ~ to the home directory', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands a ~/ prefix to the home directory', () => {
    expect(expandHome('~/.estival')).toBe(join(homedir(), '.estival'));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/etc/estival')).toBe('/etc/estival');
  });

  it('leaves relative paths without ~ unchanged', () => {
    expect(expandHome('config/dir')).toBe('config/dir');
  });

  it('does not expand a ~ that is not at the start', () => {
    expect(expandHome('/a/~/b')).toBe('/a/~/b');
  });
});
