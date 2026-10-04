import type {
  AssistantMessage,
  ChatCompletionResponse,
  Message,
  ToolSpec,
} from './types.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const MODEL = 'openrouter/free';

export async function callModel(
  messages: Message[],
  tools: ToolSpec[],
): Promise<AssistantMessage> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing from .env.');
  }

  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
  };

  if (tools.length > 0) {
    body.tools = tools.map(tool => tool.definition);
    body.tool_choice = 'auto';
  }

    const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed with ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const message = data.choices[0]?.message;
  if (!message) {
    throw new Error('OpenRouter returned no assistant message.');
  }

  return message;
}