import {execFile} from 'node:child_process';
import {readFile, realpath, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {parse, resolve} from 'node:path';

const MAX_INSTRUCTIONS = 8_000;

export interface Project {
  root: string;
  branch: string | null;
  isGitRepo: boolean;
  instructions: string | null;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise(done => {
    execFile('git', args, {cwd}, (error, stdout) =>
      done(error ? null : stdout.trim()),
    );
  });
}

// The project is the git repository around `start`, or `start` itself.
export async function detectProject(
  start: string,
  explicit: boolean,
): Promise<Project> {
  const directory = await realpath(resolve(start));
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }

  const gitRoot = explicit
    ? null
    : await git(directory, ['rev-parse', '--show-toplevel']);
  const root = gitRoot ? await realpath(gitRoot) : directory;

  // Refuse roots where one bad approval could damage the whole machine.
  if (!explicit) {
    const home = await realpath(homedir()).catch(() => homedir());
    if (root === home || root === parse(root).root) {
      throw new Error(
        `Refusing to use ${root} as the project. Run agent-harness inside a ` +
          'project folder, or pass --workspace <dir> to choose one explicitly.',
      );
    }
  }

  const isGitRepo =
    (await git(root, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  const branch = isGitRepo
    ? await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    : null;

  return {root, branch, isGitRepo, instructions: await loadInstructions(root)};
}

// Project-specific guidance, in the files other coding agents also read.
async function loadInstructions(root: string): Promise<string | null> {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try {
      const text = await readFile(resolve(root, name), 'utf8');
      return text.length > MAX_INSTRUCTIONS
        ? `${text.slice(0, MAX_INSTRUCTIONS)}\n… (truncated)`
        : text;
    } catch {
      // Not present.
    }
  }
  return null;
}
