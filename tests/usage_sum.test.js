// node --test tests/usage_sum.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('node:child_process');
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

const cli = (args, options) => spawnSync(process.execPath, [
  path.join(__dirname, '../skills/orkestra/usage_sum.js'), ...args,
], { encoding: 'utf8', ...options });

test('--here --budget compares all Claude reads, conductor reads and wall time', () => {
  const { root, proj } = fixture();
  const cwd = path.join(root, 'sample workspace');
  const projects = path.join(root, '.claude', 'projects');
  const board = path.join(cwd, 'sample board.md');
  fs.mkdirSync(cwd);
  fs.mkdirSync(projects, { recursive: true });
  fs.appendFileSync(path.join(proj, 'sess1.jsonl'), '\n' + JSON.stringify({
    type: 'user', timestamp: '2026-10-28T11:15:00Z', message: { content: 'checkpoint' },
  }));
  fs.renameSync(proj, path.join(projects, encodeProjectDir(cwd)));
  fs.writeFileSync(board, '# Board\n\n## Budget\n- Estimate: claude_reads=0.0084M conductor=0.004M time=2.5h\n');
  const options = { cwd, env: { ...process.env, HOME: root, USERPROFILE: root } };
  const result = cli(['--here', '--budget', 'sample board.md'], options);
  assert.strictEqual(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /TOTAL[^\r\n]*\r?\nbudget: claude_reads 0\.00M \/ 0\.0084M \(50%\), conductor 0\.00M \/ 0\.004M \(100%\), time 1\.3h \/ 2\.5h\s*$/);
  const json = cli(['--here', '--budget', board, '--json'], options);
  assert.strictEqual(json.status, 0, json.stderr);
  assert.deepStrictEqual(JSON.parse(json.stdout).budget, {
    claude_reads: { spent: 0.0042, estimate: 0.0084, pct: 50 },
    conductor: { spent: 0.004, estimate: 0.004, pct: 100 },
    time: { spent: 1.3, estimate: 2.5 },
  });
});

test('--budget reads a partial CRLF estimate and ignores estimates in other sections', () => {
  const { root, proj } = fixture();
  const board = path.join(root, 'board.md');
  fs.writeFileSync(board, '## Budget\r\n- Estimate: conductor=.01M\r\n## Other\r\n- Estimate: time=1h\r\n');
  const result = cli([proj, 'sess1', '--budget', board]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /budget: conductor 0\.00M \/ 0\.01M \(40%\)\s*$/);
});

test('--budget reports a board without a Budget section and refuses an unreadable board', () => {
  const { root, proj } = fixture();
  const board = path.join(root, 'board.md');
  const args = [proj, 'sess1', '--budget'];
  fs.writeFileSync(board, '## Plan\n- Estimate: time=1h\n');
  const result = cli([...args, board]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /budget: no estimate on the board\s*$/);
  const json = cli([...args, board, '--json']);
  assert.strictEqual(json.status, 0, json.stderr);
  assert.deepStrictEqual(JSON.parse(json.stdout).budget, {});
  const missing = cli([...args, path.join(root, 'absent.md')]);
  assert.strictEqual(missing.status, 2);
  assert.strictEqual(missing.stderr.trim(), 'cannot read budget board (ENOENT)');
});
