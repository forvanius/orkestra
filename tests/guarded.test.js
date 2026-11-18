// node --test tests/guarded.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { latestQuota, quotaBlocks, acquireSlot } = require('../skills/orkestra/guarded.js');

const SCRIPT = path.join(__dirname, '../skills/orkestra/guarded.js');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

function fakeHome(primary, secondary) {
  const home = tmp('ork-g-home-'), d = path.join(home, '.codex', 'sessions', '2026', '11', '09');
  fs.mkdirSync(d, { recursive: true });
  const line = used => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', rate_limits: used } });
  fs.writeFileSync(path.join(d, 'rollout-a.jsonl'), [line({ primary: { used_percent: 10 } }), line({ primary, secondary })].join('\n'));
  return home;
}

function cli(args, { home, slotDir, input } = {}) {
  const env = { ...process.env };
  if (home) { env.HOME = home; env.USERPROFILE = home; }
  if (slotDir) env.ORKESTRA_SLOT_DIR = slotDir;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, input: input == null ? '' : input, timeout: 30_000 });
}

function childScript(body) {
  const f = path.join(tmp('ork-g-child-'), 'child.js');
  fs.writeFileSync(f, body);
  return f;
}
const node = [process.execPath];

test('quota comes from the last record of the newest Codex file; a window already reset counts as empty', () => {
  const now = Date.now(), future = Math.round(now / 1000) + 3600, past = Math.round(now / 1000) - 3600;
  const pick = q => ({ windowPct: q.windowPct, weeklyPct: q.weeklyPct });
  assert.deepStrictEqual(pick(latestQuota(fakeHome({ used_percent: 84, resets_at: future }, { used_percent: 79, resets_at: future }), now)), { windowPct: 84, weeklyPct: 79 });
  assert.deepStrictEqual(pick(latestQuota(fakeHome({ used_percent: 99, resets_at: past }, { used_percent: 5, resets_at: future }), now)), { windowPct: 0, weeklyPct: 5 });
  assert.strictEqual(latestQuota(tmp('ork-g-empty-')), null);
});

test('a block says how old the figure is, since an early renewal only shows after the next Codex run', () => {
  const now = Date.now(), home = fakeHome({ used_percent: 10 }, { used_percent: 91 });
  const f = path.join(home, '.codex', 'sessions', '2026', '11', '09', 'rollout-a.jsonl');
  fs.writeFileSync(f, JSON.stringify({ timestamp: new Date(now - 5 * 36e5).toISOString(), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10 }, secondary: { used_percent: 91 } } } }));
  const q = latestQuota(home, now);
  assert.strictEqual(q.ageHours, 5);
  const why = quotaBlocks(q);
  assert.match(why[0], /week 91%/);
  assert.match(why[1], /recorded 5 h ago.*--ignore-quota/);
  assert.deepStrictEqual(quotaBlocks({ ...q, weeklyPct: 10 }), []);
});

test('quota limits', () => {
  assert.deepStrictEqual(quotaBlocks({ windowPct: 84, weeklyPct: 89 }), []);
  assert.strictEqual(quotaBlocks({ windowPct: 85, weeklyPct: 90 }).length, 2);
  assert.deepStrictEqual(quotaBlocks(null), []);                                  // no data never blocks
});

test('a Codex run near the limit never starts; --ignore-quota overrides', () => {
  const home = fakeHome({ used_percent: 95 }, { used_percent: 20 }), mark = path.join(tmp('ork-g-m-'), 'ran.txt');
  const child = childScript(`require('fs').writeFileSync(${JSON.stringify(mark)}, 'x')`);
  const r = cli(['codex', '--', ...node, child], { home });
  assert.strictEqual(r.status, 4);
  assert.match(r.stdout, /"guarded":"quota"/);
  assert.ok(!fs.existsSync(mark));
  assert.strictEqual(cli(['codex', '--ignore-quota', '--', ...node, child], { home }).status, 0);
  assert.ok(fs.existsSync(mark));
  assert.strictEqual(cli(['quota'], { home }).status, 4);
  assert.strictEqual(cli(['quota'], { home: fakeHome({ used_percent: 1 }, { used_percent: 1 }) }).status, 0);
});

test('stdin, stdout and the exit code pass through, as `- < brief.txt` needs', () => {
  const child = childScript(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('got:'+s);process.exit(7)})`);
  const r = cli(['heavy', '--', ...node, child], { slotDir: tmp('ork-g-s-'), input: 'the brief' });
  assert.strictEqual(r.status, 7);
  assert.match(r.stdout, /got:the brief/);
});

test('the time limit stops the whole run and frees the slot', () => {
  const slotDir = tmp('ork-g-s-');
  const child = childScript(`setInterval(()=>{},1000)`);
  const r = cli(['heavy', '--minutes', '0.02', '--', ...node, child], { slotDir });
  assert.strictEqual(r.status, 124);
  assert.match(r.stdout, /"guarded":"timeout"/);
  assert.deepStrictEqual(fs.readdirSync(slotDir), []);
});

test('slots are shared across runs; a dead owner\'s slot is taken over', async () => {
  const slotDir = tmp('ork-g-s-');
  fs.writeFileSync(path.join(slotDir, 'slot-0'), String(process.pid));           // a live owner
  const child = childScript(`console.log('ran')`);
  const r = cli(['heavy', '--slots', '1', '--wait-minutes', '0', '--', ...node, child], { slotDir });
  assert.strictEqual(r.status, 6);
  assert.match(r.stdout, /"guarded":"no-slot"/);
  assert.strictEqual(cli(['heavy', '--slots', '2', '--wait-minutes', '0', '--', ...node, child], { slotDir }).status, 0);   // second slot free

  fs.writeFileSync(path.join(slotDir, 'slot-0'), '999999');                      // a dead owner
  const f = await acquireSlot(slotDir, 1, 0.05);
  assert.strictEqual(path.basename(f), 'slot-0');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), String(process.pid));
});

test('bad usage exits 2', () => {
  assert.strictEqual(cli(['heavy']).status, 2);
  assert.strictEqual(cli(['nope', '--', 'x']).status, 2);
});
