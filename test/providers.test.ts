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
