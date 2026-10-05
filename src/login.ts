import {createInterface} from 'node:readline/promises';
import process from 'node:process';
import {configPath, loadConfig, saveConfig} from './config.ts';
import {PRESETS} from './providers/index.ts';

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

export async function login(): Promise<void> {
  const config = await loadConfig();
  const rl = createInterface({input: process.stdin, output: process.stdout});

  let presetIndex: number;
  let model: string;
  let baseURL: string | undefined;
  try {
    console.log('Choose a provider:');
    PRESETS.forEach((preset, index) => {
      console.log(`  ${index + 1}. ${preset.label}`);
    });
    const choice = await rl.question(`Number [1-${PRESETS.length}]: `);
    presetIndex = Number.parseInt(choice, 10) - 1;
    if (!PRESETS[presetIndex]) throw new Error('Invalid choice.');

    const preset = PRESETS[presetIndex];
    if (preset.id === 'custom') {
      baseURL =
        (await rl.question('Base URL (e.g. https://host/v1): ')).trim() ||
        undefined;
      if (!baseURL) throw new Error('A base URL is required.');
    }
    const fallback = config.providers[preset.id]?.model ?? preset.defaultModel;
    model =
      (
        await rl.question(`Model${fallback ? ` [${fallback}]` : ''}: `)
      ).trim() || fallback;
    if (!model) throw new Error('A model is required.');
  } finally {
    rl.close();
  }

  const preset = PRESETS[presetIndex];
  let apiKey: string | undefined;
  if (preset.keyEnv) {
    if (preset.keyURL) console.log(`Get a key at ${preset.keyURL}`);
    apiKey = await readHidden('API key (input hidden): ');
    if (!apiKey && preset.id !== 'custom') {
      throw new Error('No key entered; nothing was saved.');
    }
  }

  config.providers[preset.id] = {
    ...config.providers[preset.id],
    ...(apiKey ? {apiKey} : {}),
    ...(baseURL ? {baseURL} : {}),
    model,
  };
  config.defaultProvider = preset.id;
  await saveConfig(config);

  console.log(
    `Saved. ${preset.label} with ${model} is now the default (${configPath()}).`,
  );
}
