import {readFileSync} from 'node:fs';
import process from 'node:process';
import {parseArgs} from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import {buildSystemPrompt, runAgent} from './agent.ts';
import {loadConfig, resolveProvider} from './config.ts';
import {login} from './login.ts';
import {detectProject} from './project.ts';
import {PRESETS, createProvider, type ResolvedProvider} from './providers/index.ts';
import {createTools} from './tools.ts';
import {runTui} from './tui/index.tsx';
import type {AgentHooks, Message} from './types.ts';

// Keep the system prompt plus roughly this many recent messages.
const MAX_HISTORY = 40;

const HELP = `Usage: agent-harness [options]
       agent-harness login
       agent-harness models [--provider <id>]

Runs a coding agent in the current project (the enclosing git repository,
or the current folder). Every file change and shell command needs your
approval.

Options:
  --provider <id>         ${PRESETS.map(p => p.id).join(', ')}
  --model <id>            Model to use (must support tool calling)
  --base-url <url>        Override the provider's API URL
  --workspace <dir>       Use this folder as the project root
  --no-shell              Disable shell commands entirely
  --command-timeout <s>   Seconds before a shell command is killed (default 120)
  -h, --help              Show this help
  -v, --version           Show the version

Commands:
  login                   Save an API key and default provider/model
  models                  List providers, or a provider's available models

Keys are read from the environment first (e.g. ANTHROPIC_API_KEY,
OPENAI_API_KEY, OPENROUTER_API_KEY), then from \`agent-harness login\`.`;

function version(): string {
  // package.json sits one level above both src/ and dist/.
  const url = new URL('../package.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as {version: string}).version;
}

function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= MAX_HISTORY + 1) return messages;

  const [system, ...rest] = messages;
  // Cut at a user message so tool calls stay paired with their results.
  let start = rest.length - MAX_HISTORY;
  while (start < rest.length && rest[start].role !== 'user') start += 1;
  return [system, ...rest.slice(start)];
}

async function listModels(resolved: ResolvedProvider): Promise<string[]> {
  const {preset, apiKey, baseURL} = resolved;
  if (preset.id === 'anthropic') {
    const client = new Anthropic({apiKey, ...(baseURL ? {baseURL} : {})});
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    return ids;
  }

  const url = `${(baseURL ?? preset.baseURL ?? '').replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    headers: apiKey ? {Authorization: `Bearer ${apiKey}`} : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Listing models failed with ${response.status}.`);
  }
  const data = (await response.json()) as {data?: Array<{id: string}>};
  return (data.data ?? []).map(model => model.id).sort();
}

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      provider: {type: 'string'},
      model: {type: 'string'},
      'base-url': {type: 'string'},
      workspace: {type: 'string'},
      'no-shell': {type: 'boolean', default: false},
      'command-timeout': {type: 'string'},
      help: {type: 'boolean', short: 'h', default: false},
      version: {type: 'boolean', short: 'v', default: false},
    },
  });

  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(version());

  const [command] = positionals;
  if (command === 'login') return login();

  const config = await loadConfig();
  const flags = {
    provider: values.provider,
    model: values.model,
    baseURL: values['base-url'],
  };

  if (command === 'models') {
    if (!values.provider) {
      console.log('Providers (default model):');
      for (const preset of PRESETS) {
        const key = preset.keyEnv ? `key: ${preset.keyEnv}` : 'no key needed';
        console.log(
          `  ${preset.id.padEnd(11)} ${preset.defaultModel || '(set --model)'}  [${key}]`,
        );
      }
      console.log('\nRun `agent-harness models --provider <id>` for live lists.');
      return;
    }
    const resolved = resolveProvider(flags, config);
    for (const id of await listModels(resolved)) console.log(id);
    return;
  }

  if (command) throw new Error(`Unknown command "${command}". See --help.`);

  const timeoutSeconds = Number(values['command-timeout'] ?? 120);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--command-timeout must be a positive number of seconds.');
  }

  const resolved = resolveProvider(flags, config);
  const provider = createProvider(resolved);
  const project = await detectProject(
    values.workspace ?? process.cwd(),
    values.workspace !== undefined,
  );
  const shell = !values['no-shell'];
  const tools = createTools({shell, commandTimeoutMs: timeoutSeconds * 1000});
  const systemPrompt = buildSystemPrompt(project, shell);
  let messages: Message[] = [];

  async function respond(message: string, hooks: AgentHooks): Promise<string> {
    const result = await runAgent(
      message,
      {...hooks, workspaceRoot: project.root},
      provider,
      systemPrompt,
      messages,
      tools,
    );
    // Preserve the returned trace for the next submission.
    messages = provider.canTrimHistory
      ? trimHistory(result.messages)
      : result.messages;
    return result.answer;
  }

  runTui(respond, {
    projectRoot: project.root,
    branch: project.branch,
    provider: provider.name,
    model: provider.model,
    shell,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
