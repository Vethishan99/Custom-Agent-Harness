import type {Provider} from '../types.ts';
import {createAnthropicProvider} from './anthropic.ts';
import {createOpenAICompatibleProvider} from './openai-compatible.ts';

export interface ProviderPreset {
  id: string;
  label: string;
  // Env var holding the API key; null for local servers that need none.
  keyEnv: string | null;
  defaultModel: string;
  baseURL?: string;
  keyURL?: string;
}

// Auto-detection tries providers in this order when several keys are set.
export const PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-5-5',
    keyURL: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    baseURL: 'https://api.openai.com/v1',
    keyURL: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (many models, some free)',
    keyEnv: 'OPENROUTER_API_KEY',
    defaultModel: 'openrouter/free',
    baseURL: 'https://openrouter.ai/api/v1',
    keyURL: 'https://openrouter.ai/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-flash-latest',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyURL: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq',
    keyEnv: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-120b',
    baseURL: 'https://api.groq.com/openai/v1',
    keyURL: 'https://console.groq.com/keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
    keyURL: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    keyEnv: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-latest',
    baseURL: 'https://api.mistral.ai/v1',
    keyURL: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local models, no key)',
    keyEnv: null,
    defaultModel: 'qwen2.5-coder',
    baseURL: 'http://localhost:11434/v1',
  },
  {
    id: 'custom',
    label: 'Any OpenAI-compatible endpoint',
    keyEnv: 'AGENT_HARNESS_API_KEY',
    defaultModel: '',
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PRESETS.find(preset => preset.id === id);
}

export interface ResolvedProvider {
  preset: ProviderPreset;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export function createProvider(resolved: ResolvedProvider): Provider {
  const {preset, model, apiKey, baseURL} = resolved;

  if (preset.id === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic needs an API key.');
    return createAnthropicProvider({apiKey, model, baseURL});
  }

  const url = baseURL ?? preset.baseURL;
  if (!url) {
    throw new Error(`${preset.label} needs a base URL. Pass --base-url <url>.`);
  }
  return createOpenAICompatibleProvider({
    name: preset.id,
    baseURL: url,
    apiKey,
    model,
    headers:
      preset.id === 'openrouter'
        ? {
            // Lets OpenRouter attribute usage to this app.
            'HTTP-Referer': 'https://github.com/Vethishan99/Custom-Agent-Herness',
            'X-Title': 'agent-harness',
          }
        : undefined,
  });
}
