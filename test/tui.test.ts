import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LineSplitter, closeOpenMarkers, inlineSpans} from '../src/tui/markdown.tsx';
import {Typewriter} from '../src/tui/typewriter.ts';

test('the typewriter reveals text gradually, speeding up for big backlogs', () => {
  const shown: string[] = [];
  const writer = new Typewriter(text => shown.push(text));
  writer.write('Hi!');
  writer.tick();
  assert.deepEqual(shown, ['H']);

  shown.length = 0;
  writer.write('x'.repeat(900));
  writer.tick();
  assert.equal(shown.join('').length, 21); // ceil(902 / 45)
});

test('typewriter actions run after the text before them, then idle resolves', async () => {
  const log: string[] = [];
  const writer = new Typewriter(text => log.push(text));
  writer.write('ab');
  writer.then(() => log.push('[event]'));
  writer.write('c');
  const idle = writer.idle();
  while (log.length < 4) writer.tick();
  assert.deepEqual(log, ['a', 'b', '[event]', 'c']);
  await idle;
});

test('the typewriter never splits an emoji', () => {
  const shown: string[] = [];
  const writer = new Typewriter(text => shown.push(text));
  writer.write('😀');
  writer.tick();
  assert.deepEqual(shown, ['😀']);
});

test('lines are split, fences hidden and blank lines collapsed', () => {
  const splitter = new LineSplitter();
  const lines = [
    ...splitter.push('\n\nIntro line\n\n\n\nSec'),
    ...splitter.push('ond\n```ts\nconst a = 1;\n\n```\nAfter'),
    ...splitter.end(),
  ];
  assert.deepEqual(lines, [
    {text: 'Intro line', code: false, first: true, gap: false},
    {text: 'Second', code: false, first: false, gap: true},
    {text: 'const a = 1;', code: true, first: false, gap: false},
    {text: '', code: true, first: false, gap: false},
    {text: 'After', code: false, first: false, gap: false},
  ]);
});

test('the line being typed is available for live display', () => {
  const splitter = new LineSplitter();
  splitter.push('Hel');
  assert.deepEqual(splitter.current(), {text: 'Hel', code: false, first: true, gap: false});
  splitter.push('lo\n```');
  assert.equal(splitter.current(), null);
});

test('inline Markdown becomes styled spans', () => {
  assert.deepEqual(inlineSpans('Use `npm test` to **verify** it, *quickly*.'), [
    {text: 'Use '},
    {text: 'npm test', code: true},
    {text: ' to '},
    {text: 'verify', bold: true},
    {text: ' it, '},
    {text: 'quickly', italic: true},
    {text: '.'},
  ]);
  assert.deepEqual(inlineSpans('See [docs](https://x.dev) now'), [
    {text: 'See '},
    {text: 'docs', link: 'https://x.dev'},
    {text: ' now'},
  ]);
  // Lone asterisks and snake_case names are not formatting.
  assert.deepEqual(inlineSpans('2 * 3 * 4 and my_var_name'), [
    {text: '2 * 3 * 4 and my_var_name'},
  ]);
});

test('inline styles nest', () => {
  assert.deepEqual(inlineSpans('**`listModels()` helper**'), [
    {bold: true, text: 'listModels()', code: true},
    {bold: true, text: ' helper'},
  ]);
});

test('open markers on the line being typed are closed or hidden', () => {
  assert.equal(closeOpenMarkers('The file `src/setu'), 'The file `src/setu`');
  assert.equal(closeOpenMarkers('1. **`listModels(res'), '1. **`listModels(res`**');
  assert.equal(closeOpenMarkers('Run `'), 'Run ');
  assert.equal(closeOpenMarkers('A **'), 'A ');
  assert.equal(closeOpenMarkers('done `x` and **y**'), 'done `x` and **y**');
});
