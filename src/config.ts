import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {PRESETS, findPreset, type ResolvedProvider} from './providers/index.ts';
import {type SecretStore, systemSecretStore} from './secrets.ts';

export interface ProviderSettings {
  // Kept in the file only when no system credential store is available.
  apiKey?: string;
  // The key is in the system credential store instead of this file.
  keyInStore?: boolean;
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

// `store` is the system credential store unless given; tests pass their own,
// or null for none.
async function secretsFor(
  store: SecretStore | null | undefined,
): Promise<SecretStore | null> {
  return store === undefined ? systemSecretStore() : store;
}

// The config as written to disk: each key moved into the store when that
// works, else left in the file. Also lists the providers whose key stayed.
function storeKeys(
  config: Config,
  secrets: SecretStore | null,
): {file: Config; inFile: string[]} {
  const providers: Record<string, ProviderSettings> = {};
  const inFile: string[] = [];
  for (const [id, {apiKey, keyInStore, ...rest}] of Object.entries(
    config.providers,
  )) {
    if (apiKey && secrets) {
      try {
        secrets.set(id, apiKey);
        providers[id] = {...rest, keyInStore: true};
        continue;
      } catch {
        // No usable store (e.g. Linux without a keyring); use the file.
      }
    }
    if (apiKey) inFile.push(id);
    providers[id] = apiKey ? {...rest, apiKey} : keyInStore ? {...rest, keyInStore} : rest;
  }
  return {file: {defaultProvider: config.defaultProvider, providers}, inFile};
}

async function writeConfigFile(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  // The file may still hold API keys, so only the owner may read it.
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
  await chmod(path, 0o600);
}

export async function loadConfig(
  path = configPath(),
  store?: SecretStore | null,
): Promise<Config> {
  let config: Config;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
    config = {
      defaultProvider: parsed.defaultProvider,
      providers: parsed.providers ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {providers: {}};
    }
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }

  const secrets = await secretsFor(store);
  if (!secrets) return config;

  // Move keys that older versions saved in the file into the store.
  const plaintext = Object.values(config.providers).filter(p => p.apiKey).length;
  if (plaintext > 0) {
    const {file, inFile} = storeKeys(config, secrets);
    if (inFile.length < plaintext) await writeConfigFile(path, file);
  }

  for (const [id, settings] of Object.entries(config.providers)) {
    if (settings.apiKey || !settings.keyInStore) continue;
    try {
      settings.apiKey = secrets.get(id);
    } catch {
      // A locked or missing store reads as no key; `login` can fix that.
    }
  }
  return config;
}

// Returns the providers whose key had to stay in the file.
export async function saveConfig(
  config: Config,
  path = configPath(),
  store?: SecretStore | null,
): Promise<{inFile: string[]}> {
  const {file, inFile} = storeKeys(config, await secretsFor(store));
  await writeConfigFile(path, file);
  return {inFile};
}

export interface ProviderFlags {
  provider?: string;
  model?: string;
  baseURL?: string;
}

// Nothing usable is set up yet: no provider, or no key for it. The CLI
// answers this by running the login steps instead of failing.
export class SetupNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupNeededError';
  }
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
    throw new SetupNeededError(
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
    throw new SetupNeededError(
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
