import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after} from 'node:test';
import {createTools} from '../src/tools.ts';
import type {ToolContext} from '../src/types.ts';

export async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-harness-')));
  after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

export function context(root: string, approved = true): ToolContext {
  return {workspaceRoot: root, emit() {}, approve: async () => approved};
}

export function tool(name: string, options = {}) {
  const found = createTools(options).find(t => t.definition.function.name === name);
  if (!found) throw new Error(`No tool ${name}`);
  return found;
}
