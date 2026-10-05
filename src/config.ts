
import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {PRESETS, findPreset, type ResolvedProvider} from './providers/index.ts';

export interface ProviderSettings {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

export interface Config {
  defaultProvider?: string;
  providers: Record<string, ProviderSettings>;
}

export function configPath(): string {
  const base =
    process.platform === 'win32' && process.env.APPDATA
      ? process.env.APPDATA
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'agent-harness', 'config.json');
}

export async function loadConfig(path = configPath()): Promise<Config> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
    return {
      defaultProvider: parsed.defaultProvider,
      providers: parsed.providers ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {providers: {}};
    }
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
}

export async function saveConfig(
  config: Config,
  path = configPath(),
): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  // The file holds API keys, so only the owner may read it.
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
  await chmod(path, 0o600);
}

export interface ProviderFlags {
  provider?: string;
  model?: string;
  baseURL?: string;
}

// Pick the provider, model, key, and URL: flags, then saved config, then
// whichever provider has an API key in the environment.
export function resolveProvider(
  flags: ProviderFlags,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProvider {
  const id =
    flags.provider ??
    env.AGENT_HARNESS_PROVIDER ??
    config.defaultProvider ??
    PRESETS.find(preset => preset.keyEnv && env[preset.keyEnv])?.id ??
    PRESETS.find(preset => config.providers[preset.id]?.apiKey)?.id;

  if (!id) {
    throw new Error(
      'No AI provider is set up. Run `agent-harness login`, or set an API ' +
        'key such as ANTHROPIC_API_KEY or OPENAI_API_KEY.',
    );
  }

  const preset = findPreset(id);
  if (!preset) {
    throw new Error(
      `Unknown provider "${id}". Choose one of: ${PRESETS.map(p => p.id).join(', ')}.`,
    );
  }

  const saved = config.providers[id] ?? {};
  const apiKey = (preset.keyEnv && env[preset.keyEnv]) || saved.apiKey;
  if (preset.keyEnv && !apiKey) {
    throw new Error(
      `No API key for ${preset.label}. Run \`agent-harness login\` or set ${preset.keyEnv}.`,
    );
  }

  const model =
    flags.model ?? env.AGENT_HARNESS_MODEL ?? saved.model ?? preset.defaultModel;
  if (!model) {
    throw new Error(`Choose a model for ${preset.label} with --model <id>.`);
  }

  return {
    preset,
    model,
    apiKey: apiKey || undefined,
    baseURL: flags.baseURL ?? saved.baseURL,
  };
}
