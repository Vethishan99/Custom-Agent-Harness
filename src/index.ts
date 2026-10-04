import 'dotenv/config';

import {mkdir, realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import process from 'node:process';
import {runAgent} from './agent.ts';
import {runTui} from './tui/index.tsx';
import type {AgentHooks, Message} from './types.ts';
import {tools} from './tools.ts';

// Keep the system prompt plus roughly this many recent messages.
const MAX_HISTORY = 40;

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= MAX_HISTORY + 1) return messages;

  const [system, ...rest] = messages;
  // Cut at a user message so tool calls stay paired with their results.
  let start = rest.length - MAX_HISTORY;
  while (start < rest.length && rest[start].role !== 'user') start += 1;
  return [system, ...rest.slice(start)];
}

async function main(): Promise<void> {
  // Keep one canonical workspace and conversation trace outside the TUI.
  const configuredRoot = resolve(process.cwd(), 'workspace');
  await mkdir(configuredRoot, {recursive: true});
  const workspaceRoot = await realpath(configuredRoot);
  let messages: Message[] = [];

  async function respond(message: string, hooks?: AgentHooks): Promise<string> {
    // Use UI hooks when available. Defaults keep the TUI compatible.
    const activeHooks: AgentHooks = hooks ?? {
      emit() {},
      approve: () => Promise.resolve(false),
    };
    const result = await runAgent(
      message,
      {...activeHooks, workspaceRoot},
      messages,
      tools,
    );
    // Preserve the returned trace for the next submission.
    messages = trimHistory(result.messages);
    return result.answer;
  }

  runTui(respond);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
