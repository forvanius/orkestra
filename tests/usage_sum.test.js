// node --test tests/usage_sum.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { encodeProjectDir, projectDirFor, latestSessions, sum, collect } = require('../skills/orkestra/usage_sum.js');

const msg = (id, model, cr, out, ts) => JSON.stringify({ type: 'assistant', timestamp: ts,
  message: { id, model, usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: cr, output_tokens: out } } });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-'));
  const proj = path.join(root, encodeProjectDir('/work/my_app'));
  fs.mkdirSync(path.join(proj, 'sess1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'), [
    msg('m1', 'opus', 1000, 5, '2026-10-28T10:00:00Z'),
    msg('m1', 'opus', 1000, 5, '2026-10-28T10:00:00Z'),          // streamed duplicate
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),  // ignored
    msg('m2', 'opus', 3000, 7, '2026-10-28T10:30:00Z'),
  ].join('\n'));
  fs.writeFileSync(path.join(proj, 'sess1', 'subagents', 'a1.jsonl'), msg('s1', 'haiku', 200, 2, '2026-10-28T10:10:00Z'));
  fs.writeFileSync(path.join(proj, 'sess1', 'subagents', 'a1.meta.json'), JSON.stringify({ description: 'verify part A' }));
  return { root, proj };
}

test('project folder name: every non-alphanumeric character becomes "-"', () => {
  assert.strictEqual(encodeProjectDir('/work/my_app'), path.resolve('/work/my_app').replace(/[^A-Za-z0-9]/g, '-'));
  assert.match(encodeProjectDir('/work/my_app'), /-work-my-app$/);
});

test('sums usage once per message id and ignores non-assistant lines', () => {
  const { proj } = fixture();
  const r = sum(path.join(proj, 'sess1.jsonl'));
  assert.strictEqual(r.n, 2);
  assert.strictEqual(r.cr, 4000);
  assert.strictEqual(r.out, 12);
});

test('collects conductor and subagents with their descriptions', () => {
  const { proj } = fixture();
  const rows = collect(proj, ['sess1']);
  assert.deepStrictEqual(rows.map(x => x.name), ['MAIN (conductor)', 'verify part A']);
  assert.strictEqual(rows[1].r.cr, 200);
});

test('--here helpers find the project folder and the newest session', () => {
  const { root, proj } = fixture();
  fs.writeFileSync(path.join(proj, 'old.jsonl'), '');
  fs.utimesSync(path.join(proj, 'old.jsonl'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.strictEqual(projectDirFor('/work/my_app', root), proj);
  assert.strictEqual(projectDirFor('/work/other', root), null);
  assert.deepStrictEqual(latestSessions(proj, 1), ['sess1']);
  assert.deepStrictEqual(latestSessions(proj, 5), ['sess1', 'old']);
});
