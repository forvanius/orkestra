// node --test tests/handoff_guard.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { guard } = require('../hooks/handoff_guard.js');

const asst = (ctx, id) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0 } } });
const skill = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'orkestra:orkestra' } }] } });
const boot = ctx => [asst(ctx), asst(ctx), asst(ctx)];

function setup(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-guard-'));
  const tp = path.join(dir, 't.jsonl');
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  const add = l => fs.appendFileSync(tp, l.join('\n') + '\n');
  const run = () => guard({ session_id: 's1', transcript_path: tp }, path.join(dir, 'data'));
  return { add, run };
}

test('silent below 250 K of growth and in sessions that never used orkestra', () => {
  assert.strictEqual(setup([skill, ...boot(20_000), asst(260_000)]).run(), null);
  assert.strictEqual(setup([...boot(20_000), asst(500_000)]).run(), null);    // big context, but no orkestra
});

test('session bootstrap is not growth (measured: +7-14 K on the first calls)', () => {
  const g = setup([skill, asst(78_000), asst(92_000), asst(100_000), asst(345_000)]);
  assert.strictEqual(g.run(), null);                 // 245 K of work; from the first call it would be 267 K
  g.add([asst(351_000)]);
  assert.match(g.run(), /~351 K, ~251 K above .*Finish the request .*\/orkestra:orkestra continue from/);
});

test('warns once past the limit, then again only every 50 K', () => {
  const g = setup([skill, ...boot(50_000), asst(150_000)]);
  assert.strictEqual(g.run(), null);
  g.add([asst(305_000)]);
  assert.match(g.run(), /~305 K, ~255 K above/);
  g.add([asst(340_000)]);
  assert.strictEqual(g.run(), null);                 // no nagging on every call
  g.add([asst(356_000)]);
  assert.match(g.run(), /~356 K/);
});

test('past the hard limit it says stop, not finish', () => {
  const g = setup([skill, ...boot(50_000), asst(460_000)]);
  assert.match(g.run(), /hard limit 400 K\)\. Start no new part/);
});

test('only a real skill load activates it (false positives found on real transcripts)', () => {
  const big = [...boot(50_000), asst(400_000)];
  const toolResult = text => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: text }] } });
  for (const noise of [
    toolResult('reference/onboard.md'), toolResult('docs/dizi/ref/board.md'),
    toolResult('node ${CLAUDE_SKILL_DIR}/board_check.js'),
    toolResult('<command-name>/orkestra</command-name>'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:/s/job/board.md' } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'orkestra:measure' } }] } }),
  ]) assert.strictEqual(setup([noise, ...big]).run(), null, noise);
  for (const name of ['orkestra', 'orkestra:orkestra']) {
    const slash = JSON.stringify({ type: 'user', message: { content: `<command-message>x</command-message>\n<command-name>/${name}</command-name>` } });
    assert.match(setup([slash, ...big]).run(), /handoff/, name);
  }
});

test('a compaction restarts the count', () => {
  const g = setup([skill, ...boot(50_000), asst(320_000)]);
  assert.match(g.run(), /~320 K/);
  g.add([asst(40_000), asst(280_000)]);
  assert.strictEqual(g.run(), null);
  g.add([asst(295_000)]);
  assert.match(g.run(), /~295 K, ~255 K above/);
});

test('one API call split over several lines counts once; zero-usage lines are ignored', () => {
  const g = setup([skill, asst(50_000, 'a'), asst(50_000, 'a'), asst(50_000, 'a'), asst(60_000, 'b'), asst(70_000, 'c'), asst(350_000, 'd')]);
  assert.match(g.run(), /~350 K, ~280 K above/);     // base is the third API call (70 K); per line it would be 50 K
  g.add([JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 0 } } }), asst(380_000, 'e')]);
  assert.strictEqual(g.run(), null);                 // +30 K since the warning; a zero line neither resets nor warns
  g.add([asst(400_000, 'f')]);
  assert.match(g.run(), /~400 K/);
  assert.strictEqual(guard({}, os.tmpdir()), null);  // bad input never throws
});

test('reads only new bytes across calls', () => {
  const g = setup([skill, ...boot(50_000)]);
  assert.strictEqual(g.run(), null);
  g.add([asst(310_000)]);
  assert.match(g.run(), /handoff/);
  assert.strictEqual(g.run(), null);
});
