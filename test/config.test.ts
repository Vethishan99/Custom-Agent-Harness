import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {loadConfig, resolveProvider, saveConfig, type Config} from '../src/config.ts';
import {tempDir} from './helpers.ts';

const empty: Config = {providers: {}};

test('flags win over config and environment', () => {
  const config: Config = {
    defaultProvider: 'openai',
    providers: {openai: {apiKey: 'o', model: 'saved'}, anthropic: {apiKey: 'a'}},
  };
  const resolved = resolveProvider({provider: 'anthropic', model: 'm'}, config, {});
  assert.equal(resolved.preset.id, 'anthropic');
  assert.equal(resolved.model, 'm');
  assert.equal(resolved.apiKey, 'a');
});

test('config default beats auto-detection; saved model is used', () => {
  const config: Config = {defaultProvider: 'openai', providers: {openai: {apiKey: 'o', model: 'saved'}}};
  const resolved = resolveProvider({}, config, {ANTHROPIC_API_KEY: 'a'});
  assert.equal(resolved.preset.id, 'openai');
  assert.equal(resolved.model, 'saved');
});

test('auto-detects the provider from environment keys', () => {
  const resolved = resolveProvider({}, empty, {OPENROUTER_API_KEY: 'r'});
  assert.equal(resolved.preset.id, 'openrouter');
  assert.equal(resolved.model, 'openrouter/free');
  assert.equal(resolved.apiKey, 'r');
});

test('environment key beats saved key', () => {
  const config: Config = {providers: {anthropic: {apiKey: 'saved'}}};
  const resolved = resolveProvider({provider: 'anthropic'}, config, {ANTHROPIC_API_KEY: 'env'});
  assert.equal(resolved.apiKey, 'env');
});

test('clear errors when nothing is configured', () => {
  assert.throws(() => resolveProvider({}, empty, {}), /agent-harness login/);
  assert.throws(() => resolveProvider({provider: 'openai'}, empty, {}), /No API key/);
  assert.throws(() => resolveProvider({provider: 'nope'}, empty, {}), /Unknown provider/);
});

test('ollama needs no key', () => {
  const resolved = resolveProvider({provider: 'ollama'}, empty, {});
  assert.equal(resolved.apiKey, undefined);
});

// An in-memory stand-in for the system credential store.
function fakeStore(options: {failSet?: boolean; failGet?: boolean} = {}) {
  const secrets = new Map<string, string>();
  return {
    secrets,
    get(account: string) {
      if (options.failGet) throw new Error('locked');
      return secrets.get(account);
    },
    set(account: string, secret: string) {
      if (options.failSet) throw new Error('no keyring');
      secrets.set(account, secret);
    },
  };
}

test('config is saved readable only by the owner', async () => {
  const path = join(await tempDir(), 'nested', 'config.json');
  await saveConfig({defaultProvider: 'openai', providers: {openai: {apiKey: 'k'}}}, path, null);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await loadConfig(path, null)).providers.openai.apiKey, 'k');
});

test('API keys go to the credential store, not the file', async () => {
  const path = join(await tempDir(), 'config.json');
  const store = fakeStore();
  const {inFile} = await saveConfig(
    {defaultProvider: 'openai', providers: {openai: {apiKey: 'secret', model: 'm'}}},
    path,
    store,
  );
  assert.deepEqual(inFile, []);
  assert.equal(store.secrets.get('openai'), 'secret');
  const onDisk = await readFile(path, 'utf8');
  assert.doesNotMatch(onDisk, /secret/);
  assert.deepEqual(JSON.parse(onDisk).providers.openai, {model: 'm', keyInStore: true});

  const loaded = await loadConfig(path, store);
  assert.equal(loaded.providers.openai.apiKey, 'secret');
  assert.equal(resolveProvider({}, loaded, {}).apiKey, 'secret');
});

test('keys saved in the file by older versions move to the store on load', async () => {
  const path = join(await tempDir(), 'config.json');
  await saveConfig({providers: {gemini: {apiKey: 'old', model: 'g'}}}, path, null);
  const store = fakeStore();
  const loaded = await loadConfig(path, store);
  assert.equal(loaded.providers.gemini.apiKey, 'old');
  assert.equal(store.secrets.get('gemini'), 'old');
  assert.doesNotMatch(await readFile(path, 'utf8'), /old/);
});

test('without a usable store, keys stay in the owner-only file', async () => {
  const path = join(await tempDir(), 'config.json');
  const {inFile} = await saveConfig(
    {providers: {openai: {apiKey: 'k'}}},
    path,
    fakeStore({failSet: true}),
  );
  assert.deepEqual(inFile, ['openai']);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).providers.openai.apiKey, 'k');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a locked store reads as a missing key, with a clear error', async () => {
  const path = join(await tempDir(), 'config.json');
  await saveConfig({defaultProvider: 'openai', providers: {openai: {apiKey: 'k'}}}, path, fakeStore());
  const loaded = await loadConfig(path, fakeStore({failGet: true}));
  assert.equal(loaded.providers.openai.apiKey, undefined);
  assert.equal(loaded.providers.openai.keyInStore, true);
  assert.throws(() => resolveProvider({}, loaded, {}), /No API key/);
});
