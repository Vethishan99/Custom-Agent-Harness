import {callModel} from './openrouter.ts';
import type {
  AgentRunResult,
  Message,
  ToolCall,
  ToolContext,
  ToolExecutionResult,
  ToolSpec,
} from './types.ts';

const MAX_TURNS = 20;
const MAX_EVENT_TEXT = 500;

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

    // Keep the transcript readable; the model still gets the full result.
    const preview = JSON.stringify(result, null, 2);
    context.emit(
      `Tool: ${call.function.name}\n${
        preview.length > MAX_EVENT_TEXT
          ? `${preview.slice(0, MAX_EVENT_TEXT)}\n… (truncated)`
          : preview
      }`,
    );
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
  }
}

const SYSTEM_PROMPT = `You are a small coding agent.
Use tools for every claim about workspace files and every local action.
Never claim an action succeeded without a matching tool result.
If a required tool is unavailable or an action is denied, say so clearly.
Return a concise response when the task is complete.`;

export async function runAgent(
  userInput: string,
  context: ToolContext,
  initialMessages: Message[] = [],
  tools: ToolSpec[] = [],
): Promise<AgentRunResult> {
  const messages: Message[] =
    initialMessages.length > 0
      ? [...initialMessages]
      : [{role: 'system', content: SYSTEM_PROMPT}];

  messages.push({role: 'user', content: userInput});

  // Bound the loop so a model that keeps calling tools cannot run forever.
  for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
    context.emit(`Model turn ${turn}`);
    const assistant = await callModel(messages, tools);
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