#!/usr/bin/env node
// Estival CLI launcher.
//   estival            boot the server in the current directory (scans ./.claude/skills)
//   estival dev        same, with --watch
//   estival init       scaffold an example skill + .env into the current directory
//   estival --help     show this help
//
// The server always scans `process.cwd()/.claude/skills`, so it runs against the
// directory you invoke it from — the package's own source lives elsewhere.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// Resolve tsx's ESM loader from the package's own node_modules, not the consumer's
// cwd — `--import tsx/esm` would otherwise look beside the user's project and fail.
const requireFromPkg = createRequire(join(pkgDir, 'package.json'));
const tsxLoader = pathToFileURL(requireFromPkg.resolve('tsx/esm')).href;
const entry = join(pkgDir, 'src', 'index.ts');
const cmd = process.argv[2];

function help() {
  process.stdout.write(
    [
      'estival — Claude Agent SDK skills as REST endpoints',
      '',
      'Usage:',
      '  estival            boot the server (scans ./.claude/skills)',
      '  estival dev        boot with --watch (reload on change)',
      '  estival init       scaffold an example skill + .env here',
      '  estival --help     show this help',
      '',
      'Config is read from .env / environment — see .env.example.',
      '',
    ].join('\n'),
  );
}

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  help();
  process.exit(0);
}

if (cmd === 'init') {
  const srcSkills = join(pkgDir, 'examples', '.claude');
  const destSkills = join(process.cwd(), '.claude');
  if (existsSync(destSkills)) {
    process.stderr.write(`.claude already exists in ${process.cwd()} — not overwriting.\n`);
  } else {
    cpSync(srcSkills, destSkills, { recursive: true });
    process.stdout.write('Created .claude/skills/hello (example skill).\n');
  }
  const envExample = join(pkgDir, '.env.example');
  const destEnv = join(process.cwd(), '.env');
  if (!existsSync(destEnv) && existsSync(envExample)) {
    copyFileSync(envExample, destEnv);
    process.stdout.write('Created .env from .env.example — fill in CLAUDE_CONFIG_DIR.\n');
  }
  process.stdout.write('\nNext: `estival` to boot the server, then `curl localhost:3000/skills`.\n');
  process.exit(0);
}

const nodeArgs = ['--import', tsxLoader];
if (cmd === 'dev') nodeArgs.push('--watch');
nodeArgs.push(entry);

const child = spawn(process.execPath, nodeArgs, { stdio: 'inherit', cwd: process.cwd() });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
