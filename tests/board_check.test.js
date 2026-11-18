// node --test tests/board_check.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { partsTable, boardCheck } = require('../skills/orkestra/board_check.js');

const ok = { verdict: 'APPROVE', blockers: [], polish: [], goodhart: [], spec: { missing: [], extra: [] } };
const head = '| Part | owner | state (ready/running/in-review/blocked/merged) | files | acceptance | commit | evidence |\n|---|---|---|---|---|---|---|\n';

function board(rows, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-board-'));
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v));
  fs.writeFileSync(path.join(dir, 'board.md'), '# Board\n\n## Parts\n' + head + rows.join('\n') + '\n');
  return path.join(dir, 'board.md');
}

test('merged part with an APPROVE review passes', () => {
  const b = board(['| A | codex | merged | a.js | npm test | abc | review=review-A.json |'], { 'review-A.json': ok });
  assert.strictEqual(boardCheck(b).code, 0);
});

test('a single review filename containing + passes', () => {
  const b = board(['| A | codex | in-review | a.js | t |  | review=r+1.json |'], { 'r+1.json': ok });
  const result = boardCheck(b, 'A');
  assert.strictEqual(result.code, 0, result.errors.join('\n'));
});

test('a high-risk part passes with two distinct APPROVE review files joined by +', () => {
  const b = board(['| A | codex | in-review | a.js | t |  | review=a.json+b.json |'], { 'a.json': ok, 'b.json': ok });
  fs.appendFileSync(b, '\n| Part | Write surface | Risk |\n|---|---|---|\n| A | a.js | high |\n');
  const result = boardCheck(b, 'A');
  assert.strictEqual(result.code, 0, result.errors.join('\n'));
});

test('merged part without a review fails (the gap found on the first real run)', () => {
  const b = board(['| A | codex | merged | a.js | npm test | abc | verifier: 12 passed |']);
  const r = boardCheck(b);
  assert.strictEqual(r.code, 1);
  assert.match(r.errors[0], /no review=/);
});

test('REVISE, forced REVISE and missing files fail', () => {
  const b = board([
    '| A | codex | merged | a.js | t | 1 | review=ra.json |',
    '| B | codex | merged | b.js | t | 2 | review=rb.json |',
    '| C | codex | merged | c.js | t | 3 | review=nope.json |',
  ], { 'ra.json': { ...ok, verdict: 'REVISE', blockers: ['x'] }, 'rb.json': { ...ok, goodhart: ['threshold lowered'] } });
  const r = boardCheck(b);
  assert.strictEqual(r.errors.length, 3);
  assert.match(r.errors[1], /forced by goodhart/);
});

test('--merge checks the part about to be merged; unmerged parts are ignored otherwise', () => {
  const b = board(['| A | codex | in-review | a.js | t |  |  |', '| B | worker | running | b.js | t |  |  |']);
  assert.strictEqual(boardCheck(b).code, 0);
  assert.strictEqual(boardCheck(b, 'A').code, 1);
  assert.match(boardCheck(b, 'Z').errors[0], /not on the board/);
});

test('review=skip needs a reason and is reported', () => {
  const b = board(['| D | worker | merged | docs | - | 4 | review=skip: docs only |', '| E | worker | merged | x | - | 5 | review=skip |']);
  const r = boardCheck(b);
  assert.deepStrictEqual(r.skips, ['part D: review skipped — docs only']);
  assert.match(r.errors[0], /part E: review=skip needs a reason/);
});

test('a handoff needs a board a new session can pick up', () => {
  const { handoffCheck } = require('../skills/orkestra/board_check.js');
  const withNext = (rows, next) => { const b = board(rows, { 'r.json': ok }); fs.appendFileSync(b, next); return b; };
  const full = '\n## Next session (fill in before a handoff)\n- Next action: brief part B\n- Open decisions: none\n- Read first: report-A.md\n';
  const row = '| A | codex | ready | a.js | t |  |  |';
  assert.strictEqual(handoffCheck(withNext([row], full)).code, 0);
  assert.match(handoffCheck(board([row])).errors[0], /no Next session section/);
  const empty = handoffCheck(withNext([row], '\n## Next session\n- Next action:\n- Open decisions:\n- Read first: x\n'));
  assert.strictEqual(empty.errors.length, 2);
  assert.match(empty.errors[0], /"Next action" is empty/);
  assert.match(handoffCheck(withNext(['| A | codex | running | a.js | t |  |  |'], full)).errors[0], /still running/);
  assert.match(handoffCheck(withNext(['| A | codex |  | a.js | t |  |  |'], full)).errors[0], /is not current/);
  assert.match(handoffCheck(withNext(['| A | codex | merged | a.js | t | 1 | no review |'], full)).errors[0], /no review=/);
  assert.strictEqual(handoffCheck('/no/board.md').code, 2);
  const tr = withNext([row], '\n## Sonraki oturum\n- Sıradaki eylem: B\n- Açık kararlar: yok\n- Önce oku: r.md\n');
  assert.strictEqual(handoffCheck(tr).code, 0);
});

test('Turkish board (pano) works', () => {
  const rows = partsTable('| Parça | sahip | durum (hazır/birleşti) | dosyalar | kabul | commit | kanıt |\n|---|---|---|---|---|---|---|\n| A | codex | birleşti | a | t | 1 | inceleme=skip: yalnız metin |\n');
  assert.deepStrictEqual(rows, [{ part: 'A', state: 'birleşti', evidence: 'inceleme=skip: yalnız metin', commit: '1' }]);
  assert.strictEqual(boardCheck('/no/such/board.md').code, 2);
});

test('a merged part must really be on HEAD — a failed cherry-pick is caught (found in the pilot)', () => {
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-repo-'));
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); g('add', '-A'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'part-A');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\npart A\n'); g('commit', '-qam', 'part A');
  const sha = g('rev-parse', '--short', 'HEAD');
  g('checkout', '-q', 'main');
  const b = board([`| A | codex | merged | a.txt | t | ${sha} | review=r.json |`], { 'r.json': ok });

  assert.match(boardCheck(b, null, repo).errors[0], /not on HEAD/);          // marked merged, never merged
  g('cherry-pick', sha);                                                    // new hash, same patch
  assert.strictEqual(boardCheck(b, null, repo).code, 0);
  assert.strictEqual(boardCheck(board(['| A | codex | merged | a.txt | t |  | review=r.json |'], { 'r.json': ok }), null, repo).errors[0], 'part A: commit cell is empty — write the merged commit');
  assert.match(boardCheck(board(['| A | codex | merged | a.txt | t | deadbeef1 | review=r.json |'], { 'r.json': ok }), null, repo).errors[0], /not found/);
  assert.strictEqual(boardCheck(b, null, os.tmpdir()).code, 2);              // not a repo
});

test('a supplied board text is checked instead of the file, with evidence read from its folder', () => {
  const b = board(['| A | codex | in-review | a.js | t |  |  |'], { 'review-A.json': ok });
  const before = fs.readFileSync(b, 'utf8');
  const proposed = before.replace('| t |  |  |', '| t |  | review=review-A.json |');
  assert.strictEqual(boardCheck(b, 'A').code, 1);
  const result = boardCheck(b, 'A', null, proposed);
  assert.strictEqual(result.code, 0, result.errors.join('\n'));
  assert.strictEqual(fs.readFileSync(b, 'utf8'), before);
});
