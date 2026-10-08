import Anthropic from '@anthropic-ai/sdk';
import {errorDetail, type FailureKind, ProviderError} from './providers/errors.ts';
import {createProvider, type ResolvedProvider} from './providers/index.ts';
import type {ToolSpec} from './types.ts';

export async function listModels(resolved: ResolvedProvider): Promise<string[]> {
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
    throw new Error(
      `Listing models failed with ${response.status}: ${errorDetail(await response.text())}`,
    );
  }
  const data = (await response.json()) as {data?: Array<{id: string}>};
  // Gemini prefixes ids with "models/", which chat requests don't use.
  return (data.data ?? []).map(model => model.id.replace(/^models\//, '')).sort();
}

// Offered during the check so a model without tool calling fails now
// rather than in the middle of a task.
const PING_TOOL: ToolSpec = {
  definition: {
    type: 'function',
    function: {
      name: 'ping',
      description: 'Does nothing. Not needed to answer.',
      parameters: {type: 'object', properties: {}},
    },
  },
  execute: async () => null,
};

export type SetupCheck =
  | {ok: true}
  | {ok: false; kind: FailureKind; message: string};

// Send one tiny request to prove the key, model and tool support all work.
export async function checkSetup(resolved: ResolvedProvider): Promise<SetupCheck> {
  try {
    const provider = createProvider(resolved);
    await provider.complete(
      [{role: 'user', content: 'Reply with the single word OK.'}],
      [PING_TOOL],
    );
    return {ok: true};
  } catch (error) {
    return {
      ok: false,
      kind: error instanceof ProviderError ? error.kind : 'other',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
