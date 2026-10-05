import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fromAnthropicContent, toAnthropicMessages} from '../src/providers/anthropic.ts';
import type {Message} from '../src/types.ts';

test('Anthropic conversion groups parallel tool results into one user message', () => {
  const messages: Message[] = [
    {role: 'system', content: 'sys'},
    {role: 'user', content: 'hi'},
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {id: 'a', type: 'function', function: {name: 'read_file', arguments: '{"path":"x"}'}},
        {id: 'b', type: 'function', function: {name: 'read_file', arguments: '{"path":"y"}'}},
      ],
    },
    {role: 'tool', tool_call_id: 'a', content: '{"ok":true,"data":1}'},
    {role: 'tool', tool_call_id: 'b', content: '{"ok":false,"error":"nope"}'},
  ];

  const {system, messages: converted} = toAnthropicMessages(messages);
  assert.equal(system, 'sys');
  assert.equal(converted.length, 3);
  assert.deepEqual(converted[1], {
    role: 'assistant',
    content: [
      {type: 'tool_use', id: 'a', name: 'read_file', input: {path: 'x'}},
      {type: 'tool_use', id: 'b', name: 'read_file', input: {path: 'y'}},
    ],
  });
  assert.deepEqual(converted[2], {
    role: 'user',
    content: [
      {type: 'tool_result', tool_use_id: 'a', content: '{"ok":true,"data":1}'},
      {type: 'tool_result', tool_use_id: 'b', content: '{"ok":false,"error":"nope"}', is_error: true},
    ],
  });
});

test('Anthropic content round-trips unchanged, thinking included', () => {
  const content = [
    {type: 'thinking', thinking: '', signature: 'sig'},
    {type: 'text', text: 'Looking.', citations: null},
    {type: 'tool_use', id: 't1', name: 'find_files', input: {pattern: '*.ts'}},
  ];
  const assistant = fromAnthropicContent(content as never);
  assert.equal(assistant.content, 'Looking.');
  assert.deepEqual(assistant.tool_calls, [
    {id: 't1', type: 'function', function: {name: 'find_files', arguments: '{"pattern":"*.ts"}'}},
  ]);

  const {messages} = toAnthropicMessages([{role: 'user', content: 'go'}, assistant]);
  assert.equal(messages[1].content, content);
});

test('retry delay honors Retry-After, else backs off exponentially', async () => {
  const {retryDelay} = await import('../src/providers/openai-compatible.ts');
  assert.equal(retryDelay(0, '2'), 2000);
  assert.equal(retryDelay(0, '999'), 30_000);
  assert.equal(retryDelay(0, null), 1000);
  assert.equal(retryDelay(2, null), 4000);
});

test('tool calls are summarized on one line', async () => {
  const {summarizeCall} = await import('../src/agent.ts');
  const call = (name: string, args: object) => ({
    id: 'x',
    type: 'function' as const,
    function: {name, arguments: JSON.stringify(args)},
  });
  assert.equal(
    summarizeCall(call('run_command', {command: 'npm test'}), {ok: true, data: {exitCode: 1}}),
    'run_command npm test → exit 1',
  );
  assert.equal(
    summarizeCall(call('edit_file', {path: 'a.js'}), {ok: true, data: {approved: false}}),
    'edit_file a.js → denied',
  );
  assert.equal(
    summarizeCall(call('read_file', {path: 'x'}), {ok: false, error: 'ENOENT'}),
    'read_file x ✗ ENOENT',
  );
});
