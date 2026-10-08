import Anthropic from '@anthropic-ai/sdk';
import type {
  AssistantMessage,
  Message,
  Provider,
  ToolCall,
  ToolSpec,
} from '../types.ts';
import {ProviderError} from './errors.ts';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
}

// Convert the harness's OpenAI-shaped history into Messages API format.
export function toAnthropicMessages(messages: Message[]): {
  system: string;
  messages: MessageParam[];
} {
  const system: string[] = [];
  const converted: MessageParam[] = [];
  // Parallel tool results must all go back in one user message.
  let pendingResults: ContentBlockParam[] = [];

  const flushResults = () => {
    if (pendingResults.length === 0) return;
    converted.push({role: 'user', content: pendingResults});
    pendingResults = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      let isError = false;
      try {
        isError = (JSON.parse(message.content) as {ok?: boolean}).ok === false;
      } catch {
        // Plain-text results are never errors.
      }
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content,
        ...(isError ? {is_error: true} : {}),
      });
      continue;
    }

    flushResults();

    if (message.role !== 'assistant') {
      if (message.role === 'system') system.push(message.content);
      else converted.push({role: 'user', content: message.content});
    } else if (Array.isArray(message.providerRaw)) {
      // Send Claude's own blocks back unchanged so thinking stays valid.
      converted.push({
        role: 'assistant',
        content: message.providerRaw as ContentBlockParam[],
      });
    } else {
      const content: ContentBlockParam[] = [];
      if (message.content) content.push({type: 'text', text: message.content});
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}') as object,
        });
      }
      converted.push({role: 'assistant', content});
    }
  }

  flushResults();
  return {system: system.join('\n\n'), messages: converted};
}

export function fromAnthropicContent(content: ContentBlock[]): AssistantMessage {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      text.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {name: block.name, arguments: JSON.stringify(block.input)},
      });
    }
  }

  return {
    role: 'assistant',
    content: text.length > 0 ? text.join('\n') : null,
    ...(toolCalls.length > 0 ? {tool_calls: toolCalls} : {}),
    providerRaw: content,
  };
}

function friendlyError(error: unknown, model: string): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderError(
      'Anthropic rejected the API key. Run `agent-harness login` to enter a new one.',
      'auth',
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`Anthropic denied access: ${error.message}`, 'auth');
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError(
      `Anthropic can't use the model "${model}" (${error.message}). ` +
        'Run `agent-harness model` to choose another.',
      'model',
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic rate limit reached. Wait a moment and retry.');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error(`Could not reach Anthropic: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${error.status}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? {baseURL: options.baseURL} : {}),
  });

  return {
    name: 'anthropic',
    model: options.model,
    // Dropping old turns would edit the history that thinking blocks are
    // bound to; Claude's 1M-token context makes trimming unnecessary.
    canTrimHistory: false,

    async complete(messages: Message[], tools: ToolSpec[], onText) {
      const {system, messages: converted} = toAnthropicMessages(messages);

      let response: Anthropic.Beta.BetaMessage;
      try {
        // Streaming shows text as it arrives and avoids HTTP timeouts on
        // long replies. A mid-stream fallback continues the same stream, so
        // text already shown stays valid.
        const stream = client.beta.messages.stream({
          model: options.model,
          max_tokens: 64000,
          ...(system ? {system} : {}),
          messages: converted,
          tools: tools.map(tool => ({
            name: tool.definition.function.name,
            description: tool.definition.function.description,
            input_schema: tool.definition.function.parameters,
          })),
          // Cache the stable prefix (tools, system prompt, earlier turns).
          cache_control: {type: 'ephemeral'},
          output_config: {effort: 'high'},
          // On a safety decline, retry on a fallback model in the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        if (onText) stream.on('text', delta => onText(delta));
        response = await stream.finalMessage();
      } catch (error) {
        throw friendlyError(error, options.model);
      }

      if (response.stop_reason === 'refusal') {
        const reason = response.stop_details?.explanation;
        throw new Error(
          `Claude declined this request${reason ? `: ${reason}` : '.'}`,
        );
      }
      if (response.stop_reason === 'max_tokens') {
        throw new Error('Claude’s response was cut off at the output limit.');
      }

      return fromAnthropicContent(response.content);
    },
  };
}
