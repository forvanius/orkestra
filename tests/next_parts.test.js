// node --test tests/next_parts.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { plan, overlap } = require('../skills/orkestra/next_parts.js');

const board = (lanes, parts) => [
  '## Lane matrix', '| Part | parallel? (yes / after: X) | write surface | risk | role | model | reviewer | acceptance (command) |', '|---|---|---|---|---|---|---|---|',
  ...lanes.map(([p, par, s]) => `| ${p} | ${par} | ${s} | low | codex | gpt | sonnet | t |`), '',
  '## Parts', '| Part | owner | state (ready/running/in-review/blocked/merged) | files | acceptance | commit | evidence |', '|---|---|---|---|---|---|---|',
  ...parts.map(([p, s]) => `| ${p} | x | ${s} | f | t |  |  |`), '',
].join('\n');

test('overlap: exact, folder and glob; different files do not collide', () => {
  assert.ok(overlap(['src/a.js'], ['SRC\\a.js']));
  assert.ok(overlap(['src/'], ['src/deep/a.js']));
  assert.ok(overlap(['src/*.js'], ['src/a.py']));
  assert.strictEqual(overlap(['src/a.js', 'docs/x.md'], ['src/b.js', 'docs/y.md']), null);
  assert.strictEqual(overlap(['srcs/a.js'], ['src/a.js']), null);
});

test('starts what is ready, holds what waits', () => {
  const r = plan(board(
    [['A', 'yes', 'a.js'], ['B', 'after: A', 'b.js'], ['C', 'yes', 'c.js'], ['D', 'after: C', 'd.js']],
    [['A', 'ready'], ['B', 'ready'], ['C', 'merged'], ['D', 'ready']],
  ));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.start, ['A', 'D']);
  assert.deepStrictEqual(r.waiting, [{ part: 'B', why: 'waits for A' }]);
});

test('parts declared parallel on the same files are a conflict; a dependency makes them fine', () => {
  const bad = plan(board([['A', 'yes', 'x.js'], ['B', 'yes', 'x.js, y.js']], [['A', 'ready'], ['B', 'ready']]));
  assert.strictEqual(bad.code, 1);
  assert.match(bad.conflicts[0], /A and B both write x\.js/);
  const ok = plan(board([['A', 'yes', 'x.js'], ['B', 'after: A', 'x.js']], [['A', 'ready'], ['B', 'ready']]));
  assert.strictEqual(ok.code, 0);
  assert.deepStrictEqual(ok.start, ['A']);
});

test('a running part holds its files; a merged part does not', () => {
  const r = plan(board([['A', 'yes', 'x.js'], ['B', 'after: A', 'x.js'], ['C', 'yes', 'c.js']], [['A', 'running'], ['B', 'ready'], ['C', 'ready']]));
  assert.deepStrictEqual(r.running, ['A']);
  assert.deepStrictEqual(r.start, ['C']);
  const after = plan(board([['A', 'yes', 'x.js'], ['B', 'after: A', 'x.js']], [['A', 'merged'], ['B', 'ready']]));
  assert.deepStrictEqual(after.start, ['B']);
});

test('risk comes before cost: a risky part cannot go to a cheap model', () => {
  const lane = (risk, model) => `## Lane\n| Part | parallel | write surface | risk | model |\n|---|---|---|---|---|\n| A | yes | a.js | ${risk} | ${model} |\n\n| Part | owner | state | commit | evidence |\n|---|---|---|---|---|\n| A | x | ready |  |  |\n`;
  assert.strictEqual(plan(lane('low', 'haiku')).code, 0);
  assert.strictEqual(plan(lane('düşük', 'codex light')).code, 0);
  assert.match(plan(lane('high', 'haiku')).conflicts[0], /A is high risk but routed to haiku/);
  assert.strictEqual(plan(lane('medium', 'gpt-light')).code, 1);
  assert.strictEqual(plan(lane('high', 'codex high')).code, 0);
  assert.match(plan(lane('', 'sonnet')).errors[0], /no risk level/);
});

test('deadlocks and bad references are reported', () => {
  const cycle = plan(board([['A', 'after: B', 'a'], ['B', 'after: A', 'b']], [['A', 'ready'], ['B', 'ready']]));
  assert.strictEqual(cycle.code, 1);
  assert.match(cycle.errors[0], /nothing can start/);
  const r = plan(board([['A', 'after: Z', ''], ['B', 'yes', 'b']], [['A', 'ready']]));
  assert.ok(r.errors.some(e => /no write surface/.test(e)));
  assert.ok(r.errors.some(e => /unknown part Z/.test(e)));
  assert.ok(r.errors.some(e => /B is in the lane matrix/.test(e)));
  assert.strictEqual(plan('# nothing').code, 2);
});

test('the board template parses and Turkish states work', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '../skills/orkestra/templates/board.md'), 'utf8');
  assert.match(plan(tpl).errors.join(), /no write surface/);                 // a template row is not filled in yet
  const tr = '| Parça | paralel | yazma yüzeyi |\n|---|---|---|\n| A | evet | a |\n| B | sonra: A | b |\n\n| Parça | sahip | durum | kanıt |\n|---|---|---|---|\n| A | x | birleşti |  |\n| B | x | hazır |  |\n';
  assert.deepStrictEqual(plan(tr).start, ['B']);
});

const { workingMode } = require('../skills/orkestra/next_parts.js');
const withMode = (value, body) => ['# Board: x', '', '## Working mode (ask the user once)', `- Mode: ${value}`, '`auto` = run to the end.', '', body].join('\n');
const simple = () => board([['A', 'yes', 'a.js']], [['A', 'ready']]);

test('working mode: an empty Mode on the board stops dispatch until the user is asked', () => {
  const r = plan(withMode('', simple()));
  assert.strictEqual(r.code, 1);
  assert.match(r.errors.join('\n'), /working mode not set/);
  assert.strictEqual(r.mode, undefined);
});

test('working mode: a value that is not auto / checkpoints / ask is not a mode', () => {
  assert.strictEqual(plan(withMode('whatever', simple())).code, 1);
});

test('working mode: a set mode is reported on every run and does not block', () => {
  for (const [value, mode] of [['checkpoints', 'checkpoints'], ['`auto`', 'auto'], ['ask — every decision', 'ask'], ['kontrol noktaları', 'checkpoints'], ['otomatik', 'auto'], ['sor', 'ask']]) {
    const r = plan(withMode(value, simple()));
    assert.strictEqual(r.code, 0, value);
    assert.strictEqual(r.mode, mode, value);
    assert.deepStrictEqual(r.start, ['A']);
  }
});

test('working mode: a Turkish section header is read too', () => {
  const text = ['## Çalışma tarzı', '- Tarz: kontrol', '', simple()].join('\n');
  assert.strictEqual(workingMode(text), 'checkpoints');
});

test('working mode: the explanation line under an empty Mode is not read as the mode', () => {
  assert.strictEqual(workingMode(withMode('', '')), '');
});

test('working mode: a board from before the section existed is not blocked', () => {
  const r = plan(simple());
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.mode, undefined);
});

test('working mode: the board template has the section with Mode empty, so a new job must ask', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '../skills/orkestra/templates/board.md'), 'utf8');
  assert.strictEqual(workingMode(tpl), '');
});
