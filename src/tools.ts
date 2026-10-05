import {exec} from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {globToRegExp, isBinaryFile, listProjectFiles, toPosix} from './files.ts';
import type {ToolSpec} from './types.ts';

const MAX_TEXT = 12_000;
const MAX_MATCHES = 50;
const MAX_FOUND_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_RANGED_FILE_BYTES = 10_000_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

function requiredString(
  args: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = args[name];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(
      `${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`,
    );
  }

  return value;
}

async function boundedPath(root: string, inputPath: string): Promise<string> {
  const rootPath = await realpath(root);
  const targetPath = await realpath(resolve(root, inputPath));
  const relativeTarget = relative(rootPath, targetPath);

  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Path escapes the project: ${inputPath}`);
  }

  return targetPath;
}

function mutationPath(root: string, inputPath: string): string {
  // Resolve the proposed target without requiring it to exist yet.
  const target = resolve(root, inputPath);
  const relativeTarget = relative(root, target);

  if (relativeTarget === '') {
    throw new Error('The project root itself cannot be modified.');
  }

  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Path escapes the project: ${inputPath}`);
  }

  return target;
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function assertNoSymlinkPath(
  root: string,
  target: string,
): Promise<void> {
  let current = root;

  // Check every existing segment before a mutation is approved.
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = resolve(current, part);

    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${part}`);
      }
    } catch (error) {
      if (isErrno(error) && error.code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }
}

async function assertRegularFile(target: string, path: string): Promise<void> {
  if (!(await lstat(target)).isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalLine(
  args: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function buildMatcher(
  query: string,
  regex: boolean,
  caseInsensitive: boolean,
): (line: string) => boolean {
  if (regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, caseInsensitive ? 'i' : '');
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }
    return line => pattern.test(line);
  }

  if (caseInsensitive) {
    const needle = query.toLowerCase();
    return line => line.toLowerCase().includes(needle);
  }
  return line => line.includes(query);
}

async function searchFiles(
  root: string,
  directory: string,
  matches: (line: string) => boolean,
): Promise<{matches: string[]; truncated: boolean}> {
  const found: string[] = [];

  for (const file of await listProjectFiles(root, directory)) {
    let lines: string[];
    try {
      // Skip large and binary files rather than loading them into memory.
      if ((await stat(file)).size > MAX_FILE_BYTES) continue;
      if (await isBinaryFile(file)) continue;
      lines = (await readFile(file, 'utf8')).split('\n');
    } catch {
      continue;
    }

    const path = toPosix(relative(root, file));
    for (const [index, line] of lines.entries()) {
      if (!matches(line)) continue;
      // Stop at the first match past the limit; it proves truncation.
      if (found.length === MAX_MATCHES) return {matches: found, truncated: true};
      found.push(`${path}:${index + 1}:${line.slice(0, 500)}`);
    }
  }

  return {matches: found, truncated: false};
}

// Keep the start and the end of long output: errors usually come last.
function clipOutput(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  const head = text.slice(0, 2_000);
  const tail = text.slice(-(MAX_TEXT - 2_000));
  return `${head}\n… (${text.length - MAX_TEXT} characters omitted) …\n${tail}`;
}

// Pass only what common tools need, so API keys never reach child processes.
function commandEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    // Windows needs these for cmd.exe and most toolchains to start.
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of keep) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

const pathProperty = {
  type: 'string',
  description: 'Path relative to the project root. Use . for the root.',
};

const readFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file in the project. For large files, pass ' +
        'start_line/end_line (1-based, inclusive) to read one section.',
      parameters: {
        type: 'object',
        properties: {
          path: pathProperty,
          start_line: {type: 'integer', description: 'First line to read.'},
          end_line: {type: 'integer', description: 'Last line to read.'},
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const path = requiredString(args, 'path');
    const startLine = optionalLine(args, 'start_line');
    const endLine = optionalLine(args, 'end_line');
    const ranged = startLine !== undefined || endLine !== undefined;
    const target = await boundedPath(context.workspaceRoot, path);

    const {size} = await stat(target);
    const limit = ranged ? MAX_RANGED_FILE_BYTES : MAX_FILE_BYTES;
    if (size > limit) {
      throw new Error(
        ranged
          ? `File is too large to read (${size} bytes).`
          : `File is too large to read whole (${size} bytes). ` +
              'Use start_line/end_line or search_directory.',
      );
    }
    if (await isBinaryFile(target)) {
      throw new Error(`Not a text file: ${path}`);
    }

    const text = await readFile(target, 'utf8');
    const relativePath = toPosix(relative(context.workspaceRoot, target));
    if (!ranged) {
      return {
        path: relativePath,
        content: text.slice(0, MAX_TEXT),
        truncated: text.length > MAX_TEXT,
      };
    }

    const lines = text.split('\n');
    const first = startLine ?? 1;
    const last = Math.min(endLine ?? lines.length, lines.length);
    if (first > last) {
      throw new Error(`start_line ${first} is past the end (${lines.length} lines).`);
    }
    const content = lines.slice(first - 1, last).join('\n');
    return {
      path: relativePath,
      start_line: first,
      end_line: last,
      total_lines: lines.length,
      content: content.slice(0, MAX_TEXT),
      truncated: content.length > MAX_TEXT,
    };
  },
};

const listFilesTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List the entries of one project directory (not recursive). ' +
        'Use find_files to search the whole tree.',
      parameters: {
        type: 'object',
        properties: {path: pathProperty},
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const path = requiredString(args, 'path');
    const target = await boundedPath(context.workspaceRoot, path);
    const entries = await readdir(target, {withFileTypes: true});

    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  },
};

const searchDirectoryTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'search_directory',
      description:
        'Search text files under a project directory, line by line. ' +
        'Skips git-ignored, binary, and very large files.',
      parameters: {
        type: 'object',
        properties: {
          path: pathProperty,
          query: {type: 'string', description: 'Text or pattern to find.'},
          regex: {
            type: 'boolean',
            description: 'Treat query as a JavaScript regular expression.',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Ignore letter case.',
          },
        },
        required: ['path', 'query'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const path = requiredString(args, 'path');
    const query = requiredString(args, 'query');
    const matcher = buildMatcher(
      query,
      optionalBoolean(args, 'regex'),
      optionalBoolean(args, 'case_insensitive'),
    );
    const target = await boundedPath(context.workspaceRoot, path);
    return await searchFiles(context.workspaceRoot, target, matcher);
  },
};

const findFilesTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'Find project files by glob, e.g. "*.ts", "src/**/*.test.ts", ' +
        '"**/{package,tsconfig}.json". Patterns without a slash match file ' +
        'names anywhere. Skips git-ignored files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {type: 'string', description: 'Glob pattern.'},
          path: {
            ...pathProperty,
            description: 'Directory to search in. Defaults to the root.',
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    const pattern = globToRegExp(requiredString(args, 'pattern'));
    const path = args.path === undefined ? '.' : requiredString(args, 'path');
    const target = await boundedPath(context.workspaceRoot, path);

    const files: string[] = [];
    for (const file of await listProjectFiles(context.workspaceRoot, target)) {
      const relativePath = toPosix(relative(context.workspaceRoot, file));
      if (!pattern.test(relativePath)) continue;
      if (files.length === MAX_FOUND_FILES) return {files, truncated: true};
      files.push(relativePath);
    }
    return {files, truncated: false};
  },
};

const writeFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 file in the project.',
      parameters: {
        type: 'object',
        properties: {
          path: pathProperty,
          content: {type: 'string', description: 'Complete new file content.'},
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    // Validate the target before requesting approval.
    const path = requiredString(args, 'path');
    const content = requiredString(args, 'content', true);
    const target = mutationPath(context.workspaceRoot, path);
    await assertNoSymlinkPath(context.workspaceRoot, target);
    if (!(await context.approve(`write ${path}`))) return {approved: false};

    // Apply only an approved mutation.
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, content, 'utf8');
    return {approved: true, path};
  },
};

const editFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace one exact text occurrence in a project file. Read the ' +
        'file first; old_text must match exactly once, including whitespace.',
      parameters: {
        type: 'object',
        properties: {
          path: pathProperty,
          old_text: {type: 'string', description: 'Exact text to replace once.'},
          new_text: {type: 'string', description: 'Replacement text.'},
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    // Require one unambiguous replacement inside the project.
    const path = requiredString(args, 'path');
    const oldText = requiredString(args, 'old_text');
    const newText = requiredString(args, 'new_text', true);
    const target = mutationPath(context.workspaceRoot, path);
    await assertNoSymlinkPath(context.workspaceRoot, target);
    await assertRegularFile(target, path);
    const source = await readFile(target, 'utf8');
    const count = source.split(oldText).length - 1;
    if (count !== 1) throw new Error(`old_text must occur exactly once; found ${count}.`);
    if (!(await context.approve(`edit ${path}`))) return {approved: false};
    await writeFile(target, source.replace(oldText, newText), 'utf8');
    return {approved: true, path};
  },
};

const deleteFileTool: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete one file in the project.',
      parameters: {
        type: 'object',
        properties: {path: pathProperty},
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  async execute(args, context) {
    // Validate the file before requesting a destructive action.
    const path = requiredString(args, 'path');
    const target = mutationPath(context.workspaceRoot, path);
    await assertNoSymlinkPath(context.workspaceRoot, target);
    await assertRegularFile(target, path);
    if (!(await context.approve(`delete ${path}`))) return {approved: false};

    await unlink(target);
    return {approved: true, path};
  },
};

function runCommandTool(timeoutMs: number): ToolSpec {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Run a shell command from the project root after the user ' +
          `approves it. Killed after ${Math.round(timeoutMs / 1000)} seconds.`,
        parameters: {
          type: 'object',
          properties: {
            command: {type: 'string', description: 'Exact shell command to run.'},
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
    async execute(args, context) {
      const command = requiredString(args, 'command');
      if (!(await context.approve(`run shell command: ${command}`))) {
        return {approved: false};
      }

      // The shell is not sandboxed: approval is the only guard.
      const options = {
        cwd: context.workspaceRoot,
        encoding: 'utf8' as const,
        timeout: timeoutMs,
        maxBuffer: 10_000_000,
        env: commandEnv(),
      };

      return await new Promise<unknown>(done => {
        exec(command, options, (error, stdout, stderr) => {
          const exitCode =
            error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
          done({
            approved: true,
            exitCode,
            timedOut: error?.killed === true,
            signal: error?.signal ?? null,
            stdout: clipOutput(String(stdout)),
            stderr: clipOutput(String(stderr)),
          });
        });
      });
    },
  };
}

export interface ToolOptions {
  shell?: boolean;
  commandTimeoutMs?: number;
}

export function createTools({
  shell = true,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}: ToolOptions = {}): ToolSpec[] {
  const tools = [
    readFileTool,
    listFilesTool,
    searchDirectoryTool,
    findFilesTool,
    writeFileTool,
    editFileTool,
    deleteFileTool,
  ];
  if (shell) tools.push(runCommandTool(commandTimeoutMs));
  return tools;
}
