import type {
  AssistantMessage,
  ChatCompletionResponse,
  Message,
  ToolSpec,
} from './types.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openrouter/free';
const REQUEST_TIMEOUT_MS = 60_000;

export async function callModel(
  messages: Message[],
  tools: ToolSpec[],
): Promise<AssistantMessage> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is missing from .env.');
  }

  const body: Record<string, unknown> = {
    model: process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    messages,
  };

  if (tools.length > 0) {
    body.tools = tools.map(tool => tool.definition);
    body.tool_choice = 'auto';
  }

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Never leave the TUI waiting on a hung request.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `OpenRouter request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw error;
  }

  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed with ${response.status}: ${await response.text()}`,
    );
  }

  const data = (await response.json()) as ChatCompletionResponse;
  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const message = data.choices?.[0]?.message;
  if (!message) {
    throw new Error('OpenRouter returned no assistant message.');
  }

  return message;
}
