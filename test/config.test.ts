import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
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

test('config is saved readable only by the owner', async () => {
  const path = join(await tempDir(), 'nested', 'config.json');
  await saveConfig({defaultProvider: 'openai', providers: {openai: {apiKey: 'k'}}}, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await loadConfig(path)).providers.openai.apiKey, 'k');
});
