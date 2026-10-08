import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runAgent} from '../src/agent.ts';
import {classifyFailure, errorDetail, providerFailure} from '../src/providers/errors.ts';
import {ChunkAccumulator, sseData} from '../src/providers/openai-compatible.ts';
import type {AssistantMessage, Provider} from '../src/types.ts';

function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of sseData(body)) out.push(data);
  return out;
}

test('SSE data lines are reassembled across chunk boundaries', async () => {
  const body = streamOf(
    ': OPENROUTER PROCESSING\n\n',
    'data: {"a":',
    '1}\r\n\r\ndata: {"b":2}\n\n',
    'data: [DONE]\n\n',
    'data: {"ignored":true}\n\n',
  );
  assert.deepEqual(await collect(body), ['{"a":1}', '{"b":2}']);
});

test('a final data line without a trailing newline is kept', async () => {
  assert.deepEqual(await collect(streamOf('data: {"a":1}')), ['{"a":1}']);
});

test('streamed text and tool calls build one assistant message', () => {
  const seen: string[] = [];
  const reply = new ChunkAccumulator('test', text => seen.push(text));
  reply.add({choices: [{delta: {content: 'Hel'}}]});
  reply.add({choices: [{delta: {content: 'lo'}}]});
  reply.add({
    choices: [
      {delta: {tool_calls: [{index: 0, id: 'c1', function: {name: 'read_file', arguments: ''}}]}},
    ],
  });
  reply.add({choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '{"path":'}}]}}]});
  reply.add({choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"a"}'}}]}}]});
  reply.add({choices: [{delta: {tool_calls: [{index: 1, id: 'c2', function: {name: 'x', arguments: '{}'}}]}}]});

  assert.deepEqual(seen, ['Hel', 'lo']);
  assert.deepEqual(reply.finish(), {
    role: 'assistant',
    content: 'Hello',
    tool_calls: [
      {id: 'c1', type: 'function', function: {name: 'read_file', arguments: '{"path":"a"}'}},
      {id: 'c2', type: 'function', function: {name: 'x', arguments: '{}'}},
    ],
  });
});

test('tool calls without index or id still get assembled and named', () => {
  const reply = new ChunkAccumulator('test');
  reply.add({choices: [{delta: {tool_calls: [{function: {name: 'a', arguments: '{}'}}]}}]});
  const message = reply.finish();
  assert.equal(message.content, null);
  assert.equal(message.tool_calls?.[0].id, 'call_0');
});

test("extra tool call fields like Gemini's thought signature are kept", () => {
  const reply = new ChunkAccumulator('gemini');
  const signature = {google: {thought_signature: 'sig'}};
  // The shape Gemini actually streams: no index, whole call in one delta.
  reply.add({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              extra_content: signature,
              function: {arguments: '{"pattern":"*.ts"}', name: 'find_files'},
              id: 'call_1',
              type: 'function',
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(reply.finish().tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: {name: 'find_files', arguments: '{"pattern":"*.ts"}'},
      extra_content: signature,
    },
  ]);
});

test('a whole non-streamed message is accepted', () => {
  const reply = new ChunkAccumulator('test');
  reply.add({choices: [{message: {content: 'Hi'}}]});
  assert.equal(reply.finish().content, 'Hi');
});

test('errors inside a stream and empty replies are reported', () => {
  assert.throws(
    () => new ChunkAccumulator('gw').add({error: {message: 'quota'}}),
    /gw error: quota/,
  );
  assert.throws(() => new ChunkAccumulator('gw').finish(), /no assistant message/);
});

test('failures are classified so the fix can be offered', () => {
  assert.equal(classifyFailure(401, 'nope'), 'auth');
  assert.equal(classifyFailure(400, 'API key not valid. Please pass a valid API key.'), 'auth');
  assert.equal(classifyFailure(404, 'The model `gpt-9` does not exist'), 'model');
  assert.equal(classifyFailure(400, 'gpt-9 is not a valid model ID'), 'model');
  assert.equal(classifyFailure(400, 'Model Not Exist'), 'model');
  assert.equal(classifyFailure(400, 'Invalid model: xyz'), 'model');
  assert.equal(classifyFailure(400, 'messages: too long'), 'other');
  assert.equal(
    classifyFailure(
      400,
      'Function call is missing a thought_signature in functionCall parts. ' +
        'This is required for tools to work correctly, and missing ' +
        'thought_signature may lead to degraded model performance.',
    ),
    'other',
  );
  assert.equal(classifyFailure(500, 'model overloaded'), 'other');
});

test('error bodies are reduced to their message', () => {
  assert.equal(errorDetail('{"error":{"message":"bad key"}}'), 'bad key');
  assert.equal(errorDetail('[{"error":{"message":"gemini"}}]'), 'gemini');
  assert.equal(errorDetail('{"error":"plain"}'), 'plain');
  assert.equal(errorDetail('<html>oops</html>'), '<html>oops</html>');

  const error = providerFailure('openai', 'gpt-9', 404, '{"error":{"message":"no such model"}}');
  assert.equal(error.kind, 'model');
  assert.match(error.message, /"gpt-9".*agent-harness model/);
});

test('the agent passes streamed text to the stream hook', async () => {
  const provider: Provider = {
    name: 'fake',
    model: 'fake',
    canTrimHistory: true,
    async complete(_messages, _tools, onText): Promise<AssistantMessage> {
      onText?.('Hi ');
      onText?.('there');
      return {role: 'assistant', content: 'Hi there'};
    },
  };
  const streamed: string[] = [];
  const result = await runAgent(
    'hello',
    {workspaceRoot: '.', emit() {}, approve: async () => true, stream: t => streamed.push(t)},
    provider,
    'system',
  );
  assert.equal(result.answer, 'Hi there');
  assert.deepEqual(streamed, ['Hi ', 'there']);
});
