import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {globToRegExp} from '../src/files.ts';
import {createTools} from '../src/tools.ts';
import {context, tempDir, tool} from './helpers.ts';

test('paths outside the project are rejected', async () => {
  const root = await tempDir();
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'secret.txt'), 'secret');
  const project = join(root, 'project');

  for (const [name, args] of [
    ['read_file', {path: '../secret.txt'}],
    ['write_file', {path: '../x.txt', content: 'x'}],
    ['delete_file', {path: '../secret.txt'}],
    ['list_files', {path: '..'}],
  ] as const) {
    await assert.rejects(tool(name).execute(args, context(project)), /escapes the project/);
  }
});

test('the project root itself cannot be written or deleted', async () => {
  const root = await tempDir();
  await assert.rejects(tool('delete_file').execute({path: '.'}, context(root)), /root itself/);
  await assert.rejects(
    tool('write_file').execute({path: '.', content: ''}, context(root)),
    /root itself/,
  );
});

test('mutations through a symlink are rejected', async () => {
  const root = await tempDir();
  const outside = await tempDir();
  await symlink(outside, join(root, 'link'));
  await assert.rejects(
    tool('write_file').execute({path: 'link/x.txt', content: 'x'}, context(root)),
    /Symbolic links/,
  );
});

test('denied approval leaves the file unchanged', async () => {
  const root = await tempDir();
  await writeFile(join(root, 'a.txt'), 'hello');
  const result = await tool('edit_file').execute(
    {path: 'a.txt', old_text: 'hello', new_text: 'bye'},
    context(root, false),
  );
  assert.deepEqual(result, {approved: false});
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'hello');
});

test('search reports truncation only past 50 matches', async () => {
  const root = await tempDir();
  await writeFile(join(root, 'fifty.txt'), Array(50).fill('hit').join('\n'));
  let result = (await tool('search_directory').execute(
    {path: '.', query: 'hit'},
    context(root),
  )) as {matches: string[]; truncated: boolean};
  assert.equal(result.matches.length, 50);
  assert.equal(result.truncated, false);

  await writeFile(join(root, 'more.txt'), 'hit');
  result = (await tool('search_directory').execute(
    {path: '.', query: 'hit'},
    context(root),
  )) as {matches: string[]; truncated: boolean};
  assert.equal(result.truncated, true);
});

test('search supports regex and case-insensitive matching, and skips binaries', async () => {
  const root = await tempDir();
  await writeFile(join(root, 'a.ts'), 'const Value = 1;\nfunction getValue() {}');
  await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0x76, 0x61, 0x6c, 0x75, 0x65]));
  const run = async (args: object) =>
    ((await tool('search_directory').execute({path: '.', ...args}, context(root))) as {
      matches: string[];
    }).matches;

  assert.deepEqual(await run({query: 'function \\w+\\(', regex: true}), [
    'a.ts:2:function getValue() {}',
  ]);
  assert.equal((await run({query: 'value', case_insensitive: true})).length, 2);
  await assert.rejects(run({query: '(', regex: true}), /Invalid regular expression/);
});

test('git-ignored files are skipped by search and find_files', async () => {
  const root = await tempDir();
  execFileSync('git', ['init', '-q'], {cwd: root});
  await writeFile(join(root, '.gitignore'), 'ignored/\n');
  await mkdir(join(root, 'ignored'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'ignored', 'a.ts'), 'needle');
  await writeFile(join(root, 'src', 'b.ts'), 'needle');

  const found = (await tool('find_files').execute({pattern: '*.ts'}, context(root))) as {
    files: string[];
  };
  assert.deepEqual(found.files, ['src/b.ts']);

  const search = (await tool('search_directory').execute(
    {path: '.', query: 'needle'},
    context(root),
  )) as {matches: string[]};
  assert.deepEqual(search.matches, ['src/b.ts:1:needle']);
});

test('node_modules is skipped outside git', async () => {
  const root = await tempDir();
  await mkdir(join(root, 'node_modules', 'pkg'), {recursive: true});
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  await writeFile(join(root, 'index.js'), 'x');
  const found = (await tool('find_files').execute({pattern: '**/*.js'}, context(root))) as {
    files: string[];
  };
  assert.deepEqual(found.files, ['index.js']);
});

test('globs match like a shell', () => {
  assert.ok(globToRegExp('*.ts').test('src/deep/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/deep/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/deep/a.ts'));
  assert.ok(globToRegExp('**/{package,tsconfig}.json').test('tsconfig.json'));
  assert.ok(!globToRegExp('*.ts').test('a.tsx'));
});

test('read_file returns a line range', async () => {
  const root = await tempDir();
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\nfour');
  const result = await tool('read_file').execute(
    {path: 'a.txt', start_line: 2, end_line: 3},
    context(root),
  );
  assert.deepEqual(result, {
    path: 'a.txt',
    start_line: 2,
    end_line: 3,
    total_lines: 4,
    content: 'two\nthree',
    truncated: false,
  });
});

test('run_command hides API keys and reports timeouts', async () => {
  const root = await tempDir();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const run = tool('run_command', {commandTimeoutMs: 1000});

  const ok = (await run.execute({command: 'echo "[$ANTHROPIC_API_KEY]"'}, context(root))) as {
    stdout: string;
    exitCode: number;
  };
  assert.equal(ok.stdout.trim(), '[]');
  assert.equal(ok.exitCode, 0);

  const slow = (await run.execute({command: 'sleep 5'}, context(root))) as {timedOut: boolean};
  assert.equal(slow.timedOut, true);
});

test('--no-shell removes run_command', () => {
  const names = createTools({shell: false}).map(t => t.definition.function.name);
  assert.ok(!names.includes('run_command'));
});
