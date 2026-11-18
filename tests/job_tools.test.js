// node --test tests/job_tools.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { newJob } = require('../skills/orkestra/new_job.js');
const { reviewPackage } = require('../skills/orkestra/review_package.js');
const { closePart } = require('../skills/orkestra/close_part.js');
const { partsTable } = require('../skills/orkestra/board_check.js');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-job-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't'); g('config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); g('add', '-A'); g('commit', '-qm', 'base');
  return { dir, g, commit: text => { fs.appendFileSync(path.join(dir, 'a.txt'), text + '\n'); g('commit', '-qam', text); return g('rev-parse', '--short', 'HEAD'); } };
}

test('a job folder lives in the repo, is ignored by git, and never overwrites a board', () => {
  const r = repo(), one = newJob(r.dir, 'yol-kapanis');
  assert.strictEqual(one.code, 0);
  assert.strictEqual(one.out.created, true);
  assert.match(fs.readFileSync(one.out.board, 'utf8'), /## Lane matrix/);
  assert.strictEqual(fs.readFileSync(one.out.board, 'utf8').split(/\r?\n/)[0], '# Board: yol-kapanis');
  assert.strictEqual(r.g('status', '--porcelain'), '');                      // ignored without touching .gitignore
  assert.ok(!fs.existsSync(path.join(r.dir, '.gitignore')));
  fs.writeFileSync(one.out.board, 'my work');
  assert.strictEqual(newJob(r.dir, 'yol-kapanis').out.created, false);
  assert.strictEqual(fs.readFileSync(one.out.board, 'utf8'), 'my work');
  assert.strictEqual((fs.readFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'utf8').match(/^\.orkestra\/$/gm) || []).length, 1);
});

test('a job started from a worktree still lands somewhere git ignores', () => {
  const r = repo(), wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-wt-')) + '/w';
  r.g('worktree', 'add', '-q', '-b', 'side', wt);
  const j = newJob(wt, 'job');
  assert.strictEqual(j.code, 0);
  assert.strictEqual(execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
});

test('bad job names and non-repos are refused', () => {
  const r = repo();
  for (const bad of ['../x', 'a/b', '', '..']) assert.strictEqual(newJob(r.dir, bad).code, 2, bad);
  assert.strictEqual(newJob(os.tmpdir(), 'x').code, 2);
});

test('a review package holds commits, files and the diff; a re-review holds only the fix', () => {
  const r = repo(), job = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-pkg-'));
  const base = r.g('rev-parse', '--short', 'HEAD'), first = r.commit('part A'), fix = r.commit('the fix');
  const all = fs.readFileSync(reviewPackage(job, 'A', base, fix, r.dir).file, 'utf8');
  assert.match(all, /part A[\s\S]*# Files[\s\S]*# Diff[\s\S]*\+the fix/);
  const scoped = fs.readFileSync(reviewPackage(job, 'A-2', first, fix, r.dir).file, 'utf8');
  assert.match(scoped, /^\+the fix$/m);
  assert.doesNotMatch(scoped, /^\+part A$/m);
});

test('an empty or wrong range cannot produce a clean-looking review', () => {
  const r = repo(), job = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-pkg-'));
  const head = r.g('rev-parse', '--short', 'HEAD');
  assert.strictEqual(reviewPackage(job, 'x', head, head, r.dir).code, 3);
  r.g('checkout', '-qb', 'other'); const elsewhere = r.commit('elsewhere');
  r.g('checkout', '-q', 'main'); const main = r.commit('on main');
  assert.strictEqual(reviewPackage(job, 'x', elsewhere, main, r.dir).code, 3);
  assert.strictEqual(reviewPackage(job, 'x', 'deadbeef1', main, r.dir).code, 2);
  assert.strictEqual(reviewPackage(job, '../x', head, main, r.dir).code, 2);
});

test('what a reviewer could not verify holds the merge until the conductor has checked it', () => {
  const r = repo();
  const base = r.g('rev-parse', 'HEAD');
  r.g('checkout', '-qb', 'p'); const sha = r.commit('part A'); r.g('checkout', '-q', 'main');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-cv-')), board = path.join(dir, 'board.md');
  reviewPackage(dir, 'A', base, sha, r.dir);
  fs.writeFileSync(board, `| Part | owner | state | commit | evidence |\n|---|---|---|---|---|\n| A | x | in-review | ${sha} |  |\n`);
  const review = path.join(dir, 'review-A.json');
  fs.writeFileSync(review, JSON.stringify({ verdict: 'APPROVE', blockers: [], polish: [], goodhart: [], spec: { missing: [], extra: [] }, cannot_verify: ['the save format lives in untouched code'] }));
  const held = closePart(board, 'A', { repo: r.dir, review });
  assert.strictEqual(held.code, 1);
  assert.strictEqual(held.out.verdict, 'NEEDS_CHECK');
  assert.deepStrictEqual(held.out.cannot_verify, ['the save format lives in untouched code']);
  assert.strictEqual(partsTable(fs.readFileSync(board, 'utf8'))[0].state, 'in-review');
  const done = closePart(board, 'A', { repo: r.dir, review, checked: 'read save.js: format | unchanged' });
  assert.strictEqual(done.code, 0, JSON.stringify(done.out));
  assert.match(partsTable(fs.readFileSync(board, 'utf8'))[0].evidence, /review=review-A\.json checked=read save\.js: format \/ unchanged/);
});

test('every skill stays under the size that survives compaction', () => {
  const root = path.join(__dirname, '..', 'skills');
  for (const s of fs.readdirSync(root)) {
    const size = fs.statSync(path.join(root, s, 'SKILL.md')).size;
    assert.ok(size < 20_000, `${s}/SKILL.md is ${size} bytes: move what is only sometimes needed to references/`);
  }
});

test('every command that runs a skill script quotes its path (a home folder may contain a space)', () => {
  const root = path.join(__dirname, '..'), found = [];
  const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(md|txt)$/.test(f)) found.push(p); } };
  for (const d of ['skills', 'agents', 'docs']) walk(path.join(root, d));
  // Every skill-dir path is either inside double quotes or a whole `code span` of its own (a path to read,
  // not a command): `node ${dir}/x.js`, `--json-schema ${dir}/s.json`, `$(cat ${dir}/s.json)` all fail.
  const dir = /(\$\{CLAUDE_SKILL_DIR\}|<skill dir>|<skill-dir>)\/[^\s`"]*/g, offenders = [];
  for (const f of found) fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(dir)) {
      const before = line[m.index - 1], after = line[m.index + m[0].length];
      if ((before === '"' && after === '"') || (before === '`' && after === '`')) continue;
      offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.slice(Math.max(0, m.index - 30), m.index + m[0].length)}`);
    }
  });
  assert.deepStrictEqual(offenders, []);
});

test('a part gets at most three reviews; a fourth needs the user\'s quoted words', () => {
  const r = repo();
  const base = r.g('rev-parse', 'HEAD'); const c = [1, 2, 3, 4, 5].map(i => r.commit('round ' + i));
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-rounds-'));
  assert.strictEqual(reviewPackage(job, 'A', base, c[0], r.dir).code, 0);
  assert.strictEqual(reviewPackage(job, 'A-2', c[0], c[1], r.dir).code, 0);
  assert.strictEqual(reviewPackage(job, 'A-3', c[1], c[2], r.dir).code, 0);
  const four = reviewPackage(job, 'A-4', c[2], c[3], r.dir);
  assert.strictEqual(four.code, 4);
  assert.match(four.error, /ask the user/);
  assert.strictEqual(reviewPackage(job, 'A-4-codex', c[2], c[3], r.dir).code, 4);                 // a second reviewer too
  assert.strictEqual(reviewPackage(job, 'A-4-claude-sonnet', c[2], c[3], r.dir).code, 4);         // a suffix with hyphens
  assert.strictEqual(reviewPackage(job, 'A-4', c[2], c[3], r.dir, { userApproved: '  ' }).code, 4);
  assert.strictEqual(reviewPackage(job, 'A-4', c[2], c[3], r.dir, { userApproved: 'one more round, then merge' }).code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(job, 'diff-A-4.range.json'), 'utf8')).user_approved, 'one more round, then merge');
  assert.strictEqual(reviewPackage(job, 'step-10', base, c[4], r.dir).code, 0);                   // not a re-review: no part "step"
});

test('the review bar: real-use bugs block, hardening and narrower edge cases of a fix are polish', () => {
  for (const f of ['skills/orkestra/templates/review.txt', 'agents/reviewer.md']) {
    const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(t, /behave wrongly in real use/, f);
    assert.match(t, /is polish, not a blocker/, f);
    assert.match(t, /narrower edge case of the fix is polish/, f);
  }
});
