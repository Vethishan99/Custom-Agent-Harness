import {createInterface} from 'node:readline/promises';
import process from 'node:process';
import {
  configPath,
  loadConfig,
  resolveProvider,
  saveConfig,
  type ProviderFlags,
} from './config.ts';
import {PRESETS, type ProviderPreset, type ResolvedProvider} from './providers/index.ts';
import {checkSetup, listModels} from './setup.ts';

// Ask one question. A fresh interface each time keeps it from fighting
// readHidden over stdin.
async function ask(question: string): Promise<string> {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const controller = new AbortController();
  rl.on('SIGINT', () => controller.abort());
  try {
    return (await rl.question(question, {signal: controller.signal})).trim();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Cancelled.');
    throw error;
  } finally {
    rl.close();
  }
}

// Read a line without echoing it, so API keys don't appear on screen.
function readHidden(prompt: string): Promise<string> {
  const {stdin, stdout} = process;
  if (!stdin.isTTY) {
    throw new Error('`agent-harness login` needs an interactive terminal.');
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value.trim());
          return;
        }
        if (char === '\u0003') {
          finish();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

// Pressing Enter keeps savedKey when there is one. Only the custom endpoint
// may go without a key, unless one is required.
async function askKey(
  preset: ProviderPreset,
  savedKey?: string,
  required = preset.id !== 'custom',
): Promise<string | undefined> {
  if (!preset.keyEnv) return undefined;
  if (preset.keyURL) console.log(`Get a key at ${preset.keyURL}`);

  const hint = savedKey
    ? '; Enter keeps the saved key'
    : required
      ? ''
      : '; Enter for none';
  const key = await readHidden(`API key (input hidden${hint}): `);
  if (key) return key;
  if (savedKey) return savedKey;
  if (!required) return undefined;
  throw new Error('No key entered; nothing was saved.');
}

// Try the settings with a real request. On failure, let the user enter a
// new key or model, save anyway, or cancel. Returns the settings to save.
async function verify(
  start: ResolvedProvider,
  canChangeKey: boolean,
): Promise<ResolvedProvider> {
  let current = start;
  for (;;) {
    process.stdout.write(`Checking ${current.preset.label} with ${current.model}... `);
    const result = await checkSetup(current);
    if (result.ok) {
      console.log('it works.');
      return current;
    }
    console.log('failed.');
    console.log(result.message);

    if (result.kind === 'auth' && current.preset.keyEnv) {
      if (!canChangeKey) throw new Error('Nothing was saved.');
      console.log('Enter a different key, or press Enter to cancel.');
      const apiKey = await askKey(current.preset, undefined, true);
      current = {...current, apiKey};
      continue;
    }

    const answer = await ask(
      'Type another model to try, "save" to keep this one anyway, or press Enter to cancel: ',
    );
    if (!answer) throw new Error('Cancelled; nothing was saved.');
    if (answer.toLowerCase() === 'save') return current;
    current = {...current, model: answer};
  }
}

// Environment variables beat saved settings, which can hide a fix.
function warnAboutOverrides(preset: ProviderPreset): void {
  const env = process.env;
  if (preset.keyEnv && env[preset.keyEnv]) {
    console.log(`Note: ${preset.keyEnv} is set and is used instead of the saved key.`);
  }
  if (env.AGENT_HARNESS_MODEL) {
    console.log('Note: AGENT_HARNESS_MODEL is set and is used instead of the saved model.');
  }
  if (env.AGENT_HARNESS_PROVIDER && env.AGENT_HARNESS_PROVIDER !== preset.id) {
    console.log('Note: AGENT_HARNESS_PROVIDER is set and picks the provider instead.');
  }
}

export async function login(): Promise<void> {
  const config = await loadConfig();

  console.log('Choose a provider:');
  PRESETS.forEach((preset, index) => {
    const current = preset.id === config.defaultProvider ? ' (current)' : '';
    console.log(`  ${index + 1}. ${preset.label}${current}`);
  });
  const choice = await ask(`Number [1-${PRESETS.length}]: `);
  const preset = PRESETS[Number.parseInt(choice, 10) - 1];
  if (!preset) throw new Error('Invalid choice.');
  const saved = config.providers[preset.id] ?? {};

  let baseURL = saved.baseURL;
  if (preset.id === 'custom') {
    baseURL =
      (await ask(`Base URL${baseURL ? ` [${baseURL}]` : ' (e.g. https://host/v1)'}: `)) ||
      baseURL;
    if (!baseURL) throw new Error('A base URL is required.');
  }

  const apiKey = await askKey(preset, saved.apiKey);

  const fallback = saved.model ?? preset.defaultModel;
  const model =
    (await ask(`Model${fallback ? ` [${fallback}]` : ''}: `)) || fallback;
  if (!model) throw new Error('A model is required.');

  const checked = await verify({preset, model, apiKey, baseURL}, true);

  config.providers[preset.id] = {
    ...saved,
    ...(checked.apiKey ? {apiKey: checked.apiKey} : {}),
    ...(baseURL ? {baseURL} : {}),
    model: checked.model,
  };
  config.defaultProvider = preset.id;
  await saveConfig(config);

  console.log(
    `Saved. ${preset.label} with ${checked.model} is now the default (${configPath()}).`,
  );
  warnAboutOverrides(preset);
}

// Change the saved model without entering the key again.
export async function switchModel(
  flags: ProviderFlags,
  requested?: string,
): Promise<void> {
  const config = await loadConfig();
  // The model flag would only hide the saved model we're replacing.
  const resolved = resolveProvider({...flags, model: undefined}, config);
  const {preset} = resolved;

  let model = requested;
  if (!model) {
    console.log(`Current: ${preset.label} / ${resolved.model}`);
    let ids: string[] = [];
    try {
      ids = await listModels(resolved);
    } catch (error) {
      console.log(
        `Could not list models: ${error instanceof Error ? error.message : error}`,
      );
    }
    ids.forEach((id, index) => {
      console.log(`  ${String(index + 1).padStart(3)}. ${id}`);
    });
    const answer = await ask(
      ids.length > 0
        ? 'Model number or id (Enter keeps the current one): '
        : 'Model id (Enter keeps the current one): ',
    );
    if (!answer) return void console.log('Unchanged.');
    model = (/^\d+$/.test(answer) ? ids[Number(answer) - 1] : undefined) ?? answer;
  }

  const checked = await verify({...resolved, model}, false);

  config.providers[preset.id] = {
    ...config.providers[preset.id],
    model: checked.model,
  };
  await saveConfig(config);
  console.log(`Saved. ${preset.label} now uses ${checked.model}.`);
  warnAboutOverrides(preset);
}
