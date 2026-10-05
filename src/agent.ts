import type {Project} from './project.ts';
import type {
  AgentRunResult,
  Message,
  Provider,
  ToolCall,
  ToolContext,
  ToolExecutionResult,
  ToolSpec,
} from './types.ts';

const MAX_TURNS = 40;
const MAX_EVENT_TEXT = 160;

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_EVENT_TEXT
    ? `${line.slice(0, MAX_EVENT_TEXT)}…`
    : line;
}

// e.g. "edit_file src/cart.js", "run_command npm test → exit 0".
export function summarizeCall(call: ToolCall, result: ToolExecutionResult): string {
  let target = '';
  try {
    const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    const main = args.command ?? args.pattern ?? args.query ?? args.path;
    if (typeof main === 'string') target = ` ${main}`;
  } catch {
    // Unparseable arguments are reported by the result below.
  }

  let outcome = '';
  if (!result.ok) {
    outcome = ` ✗ ${result.error}`;
  } else {
    const data = result.data as Record<string, unknown> | null;
    if (data && data.approved === false) outcome = ' → denied';
    else if (data && typeof data.exitCode === 'number') {
      outcome = data.timedOut ? ' → timed out' : ` → exit ${data.exitCode}`;
    } else if (data && Array.isArray(data.matches)) {
      outcome = ` → ${data.matches.length} matches`;
    } else if (data && Array.isArray(data.files)) {
      outcome = ` → ${data.files.length} files`;
    }
  }

  return clip(`${call.function.name}${target}${outcome}`);
}

async function executeToolCalls(
  calls: ToolCall[],
  messages: Message[],
  tools: ToolSpec[],
  context: ToolContext,
): Promise<void> {
  const toolMap = new Map(
    tools.map(tool => [tool.definition.function.name, tool]),
  );

  for (const call of calls) {
    let result: ToolExecutionResult;

    try {
      const tool = toolMap.get(call.function.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${call.function.name}`);
      }

      // Some models send an empty string for tools without arguments.
      const value: unknown = JSON.parse(call.function.arguments || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Tool arguments must decode to a JSON object.');
      }

      const data = await tool.execute(
        value as Record<string, unknown>,
        context,
      );
      result = {ok: true, data};
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // One readable line per call; the model still gets the full result.
    context.emit(summarizeCall(call, result));
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
  }
}

export function buildSystemPrompt(project: Project, shell: boolean): string {
  const lines = [
    'You are a coding agent working in the user\'s project from their terminal.',
    `Project root: ${project.root}`,
    `Operating system: ${process.platform}`,
    project.isGitRepo
      ? `Git branch: ${project.branch ?? 'unknown'}`
      : 'This project is not a git repository.',
    '',
    'How to work:',
    '- Explore before changing anything: use find_files and search_directory ' +
      'to locate code, and read_file before edit_file.',
    '- All paths are relative to the project root. You cannot access files ' +
      'outside it.',
    '- Prefer small, targeted edit_file changes over rewriting whole files.',
    shell
      ? '- Use run_command to run tests, builds, and linters to verify your ' +
        'changes. The user approves every command.'
      : '- Shell commands are disabled in this session. Tell the user which ' +
        'commands to run themselves.',
    '- Use tools for every claim about files and every local action. Never ' +
      'claim an action succeeded without a matching tool result.',
    '- If the user denies an action, do not retry it; explain what you ' +
      'would have done instead.',
    '- Finish with a concise summary of what you changed and how you ' +
      'verified it.',
  ];

  if (project.instructions) {
    lines.push(
      '',
      'Project instructions (from the repository; follow them unless they ' +
        'conflict with the rules above):',
      project.instructions,
    );
  }

  return lines.join('\n');
}

export async function runAgent(
  userInput: string,
  context: ToolContext,
  provider: Provider,
  systemPrompt: string,
  initialMessages: Message[] = [],
  tools: ToolSpec[] = [],
): Promise<AgentRunResult> {
  const messages: Message[] =
    initialMessages.length > 0
      ? [...initialMessages]
      : [{role: 'system', content: systemPrompt}];

  messages.push({role: 'user', content: userInput});

  // Bound the loop so a model that keeps calling tools cannot run forever.
  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    const assistant = await provider.complete(messages, tools);
    messages.push(assistant);

    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        messages,
        answer: assistant.content ?? 'No text returned.',
      };
    }

    await executeToolCalls(calls, messages, tools, context);
  }

  return {
    messages,
    answer: `Stopped: reached the limit of ${MAX_TURNS} model turns.`,
  };
}