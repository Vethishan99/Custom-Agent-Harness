import type {
  AssistantMessage,
  Message,
  Provider,
  ToolCall,
  ToolSpec,
} from '../types.ts';
import {ProviderError, providerFailure} from './errors.ts';

// Give up when the server sends nothing for this long, before or during a
// reply. A long reply that keeps streaming is never cut off.
const IDLE_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Honor the server's Retry-After (capped), else back off 1s, 2s, 4s.
export function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000;
  return 1000 * 2 ** attempt;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {name?: string; arguments?: string};
  // Anything else (e.g. Gemini's extra_content) is kept and sent back.
  [extra: string]: unknown;
}

interface ChatChunk {
  choices?: Array<{
    delta?: {content?: string | null; tool_calls?: ToolCallDelta[]};
    // Servers that ignore `stream` send a whole message instead.
    message?: {content?: string | null; tool_calls?: ToolCall[]};
  }>;
  // Some gateways report errors inside a 200 response.
  error?: {message: string; code?: number | string};
}

// Builds one assistant message from streamed chunks.
export class ChunkAccumulator {
  private content = '';
  private sawContent = false;
  private calls: ToolCall[] = [];

  constructor(
    private readonly name: string,
    private readonly onText?: (text: string) => void,
  ) {}

  add(chunk: ChatChunk): void {
    if (chunk.error) {
      throw new ProviderError(`${this.name} error: ${chunk.error.message}`, 'other');
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;

    if (choice.message) {
      this.addText(choice.message.content);
      for (const call of choice.message.tool_calls ?? []) this.calls.push(call);
      return;
    }

    this.addText(choice.delta?.content);
    for (const delta of choice.delta?.tool_calls ?? []) this.addToolCall(delta);
  }

  private addText(text: string | null | undefined): void {
    if (typeof text !== 'string') return;
    this.sawContent = true;
    if (!text) return;
    this.content += text;
    this.onText?.(text);
  }

  // A call's id and name come in its first delta; its arguments arrive in
  // pieces. Gemini omits `index`, so fall back to matching by id.
  private addToolCall(delta: ToolCallDelta): void {
    let call =
      delta.index !== undefined
        ? this.calls[delta.index]
        : delta.id
          ? this.calls.find(existing => existing.id === delta.id)
          : this.calls.at(-1);

    if (!call) {
      call = {
        id: delta.id ?? '',
        type: 'function',
        function: {name: '', arguments: ''},
      };
      if (delta.index !== undefined) this.calls[delta.index] = call;
      else this.calls.push(call);
    }

    const {index: _index, id, type: _type, function: fn, ...extra} = delta;
    Object.assign(call, extra);
    if (id) call.id = id;
    if (fn?.name) call.function.name += fn.name;
    if (fn?.arguments) call.function.arguments += fn.arguments;
  }

  finish(): AssistantMessage {
    // Drop holes left by sparse indexes, and name calls that came without ids.
    const calls = this.calls
      .filter(Boolean)
      .map((call, i) => (call.id ? call : {...call, id: `call_${i}`}));

    if (!this.sawContent && calls.length === 0) {
      throw new ProviderError(`${this.name} returned no assistant message.`, 'other');
    }
    return {
      role: 'assistant',
      content: this.content || null,
      ...(calls.length > 0 ? {tool_calls: calls} : {}),
    };
  }
}

// Split a server-sent event stream into the JSON payload of each `data:` line.
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const {done, value} = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});

    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      // Skip blank lines, event names and ": keep-alive" comments.
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield data;
    }

    if (done) {
      const last = buffer.trim();
      if (last.startsWith('data:') && last.slice(5).trim() !== '[DONE]') {
        yield last.slice(5).trim();
      }
      return;
    }
  }
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

    async complete(messages: Message[], tools: ToolSpec[], onText) {
      const body: Record<string, unknown> = {
        model: options.model,
        stream: true,
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

      // Abort when the server goes quiet; each received chunk resets it.
      const controller = new AbortController();
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, IDLE_TIMEOUT_MS);
      };
      const timeoutError = () =>
        new ProviderError(
          `${options.name} sent nothing for ${IDLE_TIMEOUT_MS / 1000}s; gave up.`,
          'other',
        );

      const send = () =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.apiKey
              ? {Authorization: `Bearer ${options.apiKey}`}
              : {}),
            ...options.headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

      try {
        let response: Response;
        for (let attempt = 0; ; attempt += 1) {
          resetTimer();
          try {
            response = await send();
          } catch (error) {
            if (timedOut) throw timeoutError();
            if (attempt < MAX_RETRIES) {
              await sleep(retryDelay(attempt, null));
              continue;
            }
            throw new ProviderError(
              `Could not reach ${options.name} at ${options.baseURL}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              'other',
            );
          }

          // Rate limits and overloaded servers are usually brief; retry them.
          if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
            await response.body?.cancel();
            await sleep(retryDelay(attempt, response.headers.get('retry-after')));
            continue;
          }
          break;
        }

        if (!response.ok) {
          throw providerFailure(
            options.name,
            options.model,
            response.status,
            await response.text(),
          );
        }

        const reply = new ChunkAccumulator(options.name, onText);
        const isStream = (response.headers.get('content-type') ?? '').includes(
          'text/event-stream',
        );
        if (!isStream || !response.body) {
          reply.add((await response.json()) as ChatChunk);
          return reply.finish();
        }

        try {
          for await (const data of sseData(response.body)) {
            resetTimer();
            let chunk: ChatChunk;
            try {
              chunk = JSON.parse(data) as ChatChunk;
            } catch {
              continue; // Ignore anything that isn't a JSON chunk.
            }
            reply.add(chunk);
          }
        } catch (error) {
          if (timedOut) throw timeoutError();
          if (error instanceof ProviderError) throw error;
          throw new ProviderError(
            `${options.name} connection dropped mid-reply: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'other',
          );
        }
        return reply.finish();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
