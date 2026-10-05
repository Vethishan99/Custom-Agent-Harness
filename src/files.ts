import {execFile} from 'node:child_process';
import {lstat, open, readdir} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';

// Directories never worth walking when git can't tell us what's ignored.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
]);

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function gitFiles(root: string, directory: string): Promise<string[] | null> {
  return new Promise(done => {
    execFile(
      'git',
      [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        relative(root, directory) || '.',
      ],
      {cwd: root, maxBuffer: 64 * 1024 * 1024},
      (error, stdout) => {
        if (error) return done(null);
        done(
          stdout
            .split('\0')
            .filter(Boolean)
            .map(file => resolve(root, file)),
        );
      },
    );
  });
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;

    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...(await walkFiles(target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }

  return files;
}

// List project files under a directory, respecting .gitignore inside a repo.
export async function listProjectFiles(
  root: string,
  directory: string,
): Promise<string[]> {
  const fromGit = await gitFiles(root, directory);
  if (!fromGit) return walkFiles(directory);

  // Git lists tracked files that were deleted and doesn't skip symlinks.
  const files: string[] = [];
  for (const file of fromGit.sort()) {
    try {
      if ((await lstat(file)).isFile()) files.push(file);
    } catch {
      // Deleted since the last commit.
    }
  }
  return files;
}

export async function isBinaryFile(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

// Convert a glob such as "src/**/*.{ts,tsx}" into a regular expression.
// Patterns without a slash match the file name anywhere, like "*.ts".
export function globToRegExp(pattern: string): RegExp {
  const anywhere = !pattern.includes('/');
  let source = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" matches zero or more directories; a bare "**" matches anything.
        const slash = pattern[i + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        source += '\\{';
      } else {
        const options = pattern.slice(i + 1, end).split(',');
        source += `(?:${options.map(escapeRegExp).join('|')})`;
        i = end;
      }
    } else {
      source += escapeRegExp(char);
    }
  }

  return new RegExp(anywhere ? `(?:^|/)${source}$` : `^${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
