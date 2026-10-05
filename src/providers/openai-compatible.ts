import type {
  AssistantMessage,
  Message,
  Provider,
  ToolSpec,
} from '../types.ts';

const REQUEST_TIMEOUT_MS = 120_000;

interface ChatCompletionResponse {
  // Some gateways return HTTP 200 with an error body and no choices.
  choices?: Array<{message: AssistantMessage}>;
  error?: {message: string; code?: number | string};
}

export interface OpenAICompatibleOptions {
  name: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
}

// One adapter for every Chat Completions-style API: OpenAI, OpenRouter,
// Gemini's OpenAI endpoint, Groq, DeepSeek, Mistral, Ollama, and others.
export function createOpenAICompatibleProvider(
  options: OpenAICompatibleOptions,
): Provider {
  const endpoint = `${options.baseURL.replace(/\/+$/, '')}/chat/completions`;

  return {
    name: options.name,
    model: options.model,
    canTrimHistory: true,

    async complete(messages: Message[], tools: ToolSpec[]) {
      const body: Record<string, unknown> = {
        model: options.model,
        // Strip fields only this harness understands.
        messages: messages.map(message =>
          message.role === 'assistant'
            ? {
                role: 'assistant',
                content: message.content,
                ...(message.tool_calls?.length
                  ? {tool_calls: message.tool_calls}
                  : {}),
              }
            : message,
        ),
      };

      if (tools.length > 0) {
        body.tools = tools.map(tool => tool.definition);
        body.tool_choice = 'auto';
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.apiKey
              ? {Authorization: `Bearer ${options.apiKey}`}
              : {}),
            ...options.headers,
          },
          body: JSON.stringify(body),
          // Never leave the TUI waiting on a hung request.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new Error(
            `${options.name} request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
          );
        }
        throw new Error(
          `Could not reach ${options.name} at ${options.baseURL}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `${options.name} request failed with ${response.status}: ${await response.text()}`,
        );
      }

      const data = (await response.json()) as ChatCompletionResponse;
      if (data.error) {
        throw new Error(`${options.name} error: ${data.error.message}`);
      }

      const message = data.choices?.[0]?.message;
      if (!message) {
        throw new Error(`${options.name} returned no assistant message.`);
      }

      return {
        role: 'assistant',
        content: message.content ?? null,
        ...(message.tool_calls?.length ? {tool_calls: message.tool_calls} : {}),
      };
    },
  };
}
