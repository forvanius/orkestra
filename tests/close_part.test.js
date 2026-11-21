// node --test tests/close_part.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { closePart } = require('../skills/orkestra/close_part.js');
const { partsTable, boardCheck } = require('../skills/orkestra/board_check.js');
const { reviewPackage } = require('../skills/orkestra/review_package.js');

const ok = { verdict: 'APPROVE', blockers: [], polish: [], goodhart: [], spec: { missing: [], extra: [] } };
const head = '| Part | owner | state (ready/running/in-review/blocked/merged) | files | acceptance | commit | evidence |\n|---|---|---|---|---|---|---|\n';

function setup({ conflict = false } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-close-'));
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-qb', 'part-A');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\npart A\n'); g('commit', '-qam', 'part A');
  const sha = g('rev-parse', '--short', 'HEAD');
  g('checkout', '-q', 'main');
  if (conflict) { fs.writeFileSync(path.join(repo, 'a.txt'), 'base\nother\n'); g('commit', '-qam', 'other'); }
  // git's identity for the cherry-pick itself
  g('config', 'user.name', 't'); g('config', 'user.email', 't@example.invalid');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-close-b-'));
  const board = path.join(dir, 'board.md');
  fs.writeFileSync(board, '# Board\n\n## Parts\n' + head + `| A | codex | in-review | a.txt | t | ${sha} |  |\n`);
  const pkg = (name = 'A', head = sha) => reviewPackage(dir, name, base, head, repo);
  pkg();
  const save = (name, v) => { fs.writeFileSync(path.join(dir, name), JSON.stringify(v)); return path.join(dir, name); };
  const row = () => partsTable(fs.readFileSync(board, 'utf8'))[0];
  return { repo, g, sha, base, board, save, row, dir, pkg };
}

test('an approved part is gated, merged and marked in one call', () => {
  const s = setup();
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(s.row().state, 'merged');
  assert.strictEqual(s.row().evidence, 'review=review-A.json');
  assert.strictEqual(s.row().commit, s.g('rev-parse', '--short', 'HEAD'));
  assert.strictEqual(fs.readFileSync(path.join(s.repo, 'a.txt'), 'utf8').replace(/\r/g, ''), 'base\npart A\n');
});

test('a REVISE merges nothing and returns the blockers', () => {
  const s = setup(), before = s.g('rev-parse', 'HEAD');
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', { ...ok, verdict: 'REVISE', blockers: ['a.txt:1 wrong'] }) });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out.verdict, 'REVISE');
  assert.deepStrictEqual(r.out.blockers, ['a.txt:1 wrong']);
  assert.strictEqual(s.g('rev-parse', 'HEAD'), before);
  assert.strictEqual(s.row().state, 'in-review');
});

test('goodhart forces REVISE even when the reviewer wrote APPROVE', () => {
  const s = setup();
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', { ...ok, goodhart: ['threshold lowered'] }) });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.out.forced_by, ['goodhart']);
});

test('no review on the board: refused', () => {
  const s = setup();
  const r = closePart(s.board, 'A', { repo: s.repo });
  assert.strictEqual(r.code, 1);
  assert.match(r.out.errors[0], /no review=/);
  assert.strictEqual(s.row().state, 'in-review');
});

test('a failed cherry-pick is aborted, the repo stays clean, the part is not marked merged (the pilot bug)', () => {
  const s = setup({ conflict: true }), before = s.g('rev-parse', 'HEAD');
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) });
  assert.strictEqual(r.code, 3);
  assert.deepStrictEqual(r.out.conflicts, ['a.txt']);
  assert.strictEqual(s.g('rev-parse', 'HEAD'), before);
  assert.strictEqual(s.g('status', '--porcelain'), '');
  assert.strictEqual(s.row().state, 'in-review');
});

test('commits already on HEAD are left alone', () => {
  const s = setup();
  s.g('cherry-pick', s.sha);
  const head = s.g('rev-parse', 'HEAD');
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(r.out.picked, 0);
  assert.strictEqual(s.g('rev-parse', 'HEAD'), head);
});

test('bad input exits 2; Turkish boards stay Turkish; CRLF is preserved', () => {
  const s = setup();
  assert.strictEqual(closePart('/no/board.md', 'A').code, 2);
  assert.strictEqual(closePart(s.board, 'Z', { repo: s.repo }).code, 2);
  assert.strictEqual(closePart(s.board, 'A', { repo: os.tmpdir(), review: s.save('review-A.json', ok) }).code, 2);
  const tr = '| Parça | sahip | durum | dosyalar | kabul | commit | kanıt |\r\n|---|---|---|---|---|---|---|\r\n' + `| A | codex | incelemede | a.txt | t | ${s.sha} | inceleme=skip: yalnız metin |\r\n`;
  fs.writeFileSync(s.board, tr);
  const r = closePart(s.board, 'A', { repo: s.repo });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  const out = fs.readFileSync(s.board, 'utf8');
  assert.match(out, /\| birleşti \|/);
  assert.match(out, /\r\n/);
  assert.deepStrictEqual(r.out.skipped_reviews, ['part A: review skipped — yalnız metin']);
});

test('a commit added after the review is not merged on its approval', () => {
  const s = setup();
  const review = s.save('review-A.json', ok);
  s.g('checkout', '-q', 'part-A'); fs.appendFileSync(path.join(s.repo, 'a.txt'), 'late\n'); s.g('commit', '-qam', 'late');
  const late = s.g('rev-parse', '--short', 'HEAD'); s.g('checkout', '-q', 'main');
  const before = s.g('rev-parse', 'HEAD');
  const r = closePart(s.board, 'A', { repo: s.repo, review, commits: [s.sha, late] });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out.verdict, 'UNREVIEWED');
  assert.match(r.out.errors[0], /review the new commits first/);
  assert.strictEqual(s.g('rev-parse', 'HEAD'), before);
  assert.strictEqual(s.row().state, 'in-review');
});

test('a review older than its package, or with no package, does not count', () => {
  const s = setup();
  const review = s.save('review-A.json', ok);
  const old = new Date(Date.now() - 60_000); fs.utimesSync(review, old, old);
  let r = closePart(s.board, 'A', { repo: s.repo, review });
  assert.strictEqual(r.out.verdict, 'UNREVIEWED');
  assert.match(r.out.errors[0], /older than its package/);
  fs.unlinkSync(path.join(s.dir, 'diff-A.range.json'));
  r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) });
  assert.match(r.out.errors[0], /no diff-A\.range\.json/);
  r = closePart(s.board, 'A', { repo: s.repo, review: s.save('result.json', ok) });
  assert.match(r.out.errors[0], /name it review-<name>\.json/);
  assert.strictEqual(s.row().state, 'in-review');
});

test('a high-risk part needs two passing reviews', () => {
  const s = setup();
  fs.appendFileSync(s.board, '\n## Lane matrix\n| Part | parallel? | write surface | domain | risk |\n|---|---|---|---|---|\n| A | yes | a.txt | code | high |\n');
  let r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) });
  assert.strictEqual(r.code, 1);
  assert.match(r.out.errors[0], /high risk: it needs two passing reviews/);
  assert.strictEqual(s.row().state, 'in-review');
  // the second reviewer reads the same package: review-A-codex.json pairs with diff-A.range.json
  r = closePart(s.board, 'A', { repo: s.repo, review: [s.save('review-A.json', ok), s.save('review-A-codex.json', ok)] });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(s.row().evidence, 'review=review-A.json+review-A-codex.json');
  s.save('review-A-codex.json', { ...ok, verdict: 'REVISE', blockers: ['x'] });
  assert.match(boardCheck(s.board).errors[0], /review review-A-codex\.json is REVISE/);
});

// Codex's review of the binding: each case below merged before the fix.
const commitOn = (s, branch, text) => { s.g('checkout', '-q', branch); fs.appendFileSync(path.join(s.repo, 'a.txt'), text + '\n'); s.g('commit', '-qam', text); const c = s.g('rev-parse', '--short', 'HEAD'); s.g('checkout', '-q', 'main'); return c; };

test('a review already on the board is bound too, not only one passed with --review', () => {
  const s = setup();
  closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok), commits: ['0000000'] });   // records nothing: bad commit
  fs.writeFileSync(s.board, fs.readFileSync(s.board, 'utf8').replace('|  |\n', '| review=review-A.json |\n'));
  const late = commitOn(s, 'part-A', 'late');
  const r = closePart(s.board, 'A', { repo: s.repo, commits: [s.sha, late] });
  assert.strictEqual(r.out.verdict, 'UNREVIEWED', JSON.stringify(r.out));
  assert.strictEqual(s.row().state, 'in-review');
});

test('only the reviewed range merges: not a commit below its base, not a subset, and its head alone means all of it', () => {
  const s = setup();
  const c2 = commitOn(s, 'part-A', 'second'), c3 = commitOn(s, 'part-A', 'third');
  fs.unlinkSync(path.join(s.dir, 'diff-A.range.json'));
  reviewPackage(s.dir, 'A', c2, c3, s.repo);   // the review saw only c3
  const review = s.save('review-A.json', ok);
  let r = closePart(s.board, 'A', { repo: s.repo, review, commits: [s.sha, c2, c3] });
  assert.strictEqual(r.out.verdict, 'UNREVIEWED');
  assert.ok(r.out.errors.some(e => e.includes(s.sha) && /is not in what/.test(e)), JSON.stringify(r.out));
  fs.unlinkSync(path.join(s.dir, 'diff-A.range.json'));
  reviewPackage(s.dir, 'A', s.base, c3, s.repo);
  r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok), commits: [s.sha, c3] });
  assert.ok(r.out.errors.some(e => /it is not being merged/.test(e)), JSON.stringify(r.out));
  r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok), commits: [c3] });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(r.out.picked, 3);
  assert.strictEqual(fs.readFileSync(path.join(s.repo, 'a.txt'), 'utf8').replace(/\r/g, ''), 'base\npart A\nsecond\nthird\n');
});

test('a re-review covers the part from its first package', () => {
  const s = setup();
  const fix = commitOn(s, 'part-A', 'fix');
  s.save('review-A.json', ok);
  reviewPackage(s.dir, 'A-2', s.sha, fix, s.repo);
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A-2.json', ok), commits: [fix] });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(r.out.picked, 2);
});

test('a chain with a missing earlier review refuses to close and writes nothing', () => {
  const s = setup(), before = s.g('rev-parse', 'HEAD'), fix = commitOn(s, 'part-A', 'fix');
  reviewPackage(s.dir, 'A-2', s.sha, fix, s.repo);   // review-A.json was never saved
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A-2.json', ok), commits: [fix] });
  assert.strictEqual(r.code, 1, JSON.stringify(r.out));
  assert.ok(r.out.errors.some(e => /review-A\.json: the review of diff-A\.range\.json is missing/.test(e)), JSON.stringify(r.out));
  assert.strictEqual(s.row().state, 'in-review');
  assert.strictEqual(s.row().evidence, '');
  assert.strictEqual(s.g('rev-parse', 'HEAD'), before);
});

test('a name packages one range; rerunning a merged part is a no-op', () => {
  const s = setup();
  const late = commitOn(s, 'part-A', 'late');
  const again = reviewPackage(s.dir, 'A', s.base, late, s.repo);
  assert.strictEqual(again.code, 3);
  assert.match(again.error, /package the new commits as A-2/);
  assert.strictEqual(reviewPackage(s.dir, 'A', s.base, s.sha, s.repo).code, 0);
  assert.strictEqual(closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) }).code, 0);
  const r = closePart(s.board, 'A', { repo: s.repo });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(r.out.already_merged, true);
});

test('high risk: no duplicate path, no empty list, no skip, and a look-alike table does not hide the lane matrix', () => {
  const s = setup();
  const text = fs.readFileSync(s.board, 'utf8');
  fs.writeFileSync(s.board, '| Part | Risk |\n|---|---|\n| A | low |\n\n' + text + '\n| Part | parallel? | write surface | risk |\n|---|---|---|---|\n| A | yes | a.txt | high |\n');
  s.save('review-A.json', ok);
  const withEvidence = ev => { fs.writeFileSync(s.board, fs.readFileSync(s.board, 'utf8').replace(/\| [^|\n]* \|\n\n\| Part \| parallel/, `| ${ev} |\n\n| Part | parallel`)); return boardCheck(s.board, 'A').errors.join(' / '); };
  assert.match(withEvidence('review=review-A.json'), /high risk/);
  assert.match(withEvidence('review=review-A.json+./review-A.json'), /listed twice/);
  assert.match(withEvidence('review=+'), /names no file/);
  assert.match(withEvidence('review=skip: docs only'), /high risk.*has a skip/);
});

test('a re-review that skips commits leaves them unreviewed; a merged rerun still checks HEAD', () => {
  const s = setup();
  const gap = commitOn(s, 'part-A', 'unreviewed'), fix = commitOn(s, 'part-A', 'fix');
  reviewPackage(s.dir, 'A-2', gap, fix, s.repo);   // should have started at s.sha
  let r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A-2.json', ok), commits: [fix] });
  assert.strictEqual(r.out.verdict, 'UNREVIEWED');
  assert.match(r.out.errors[0], /nothing reviewed the commits after/);
  assert.strictEqual(closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) }).code, 0);
  s.g('reset', '-q', '--hard', s.base);
  r = closePart(s.board, 'A', { repo: s.repo });
  assert.strictEqual(r.code, 1);
  assert.match(r.out.errors[0], /marked merged, but/);
});

test('a pick that fails for want of a git identity says so; a rerun replaces its checked= note', () => {
  const s = setup({ conflict: true });
  const review = s.save('review-A.json', ok);
  let r = closePart(s.board, 'A', { repo: s.repo, review, checked: 'first look' });
  assert.strictEqual(r.out.cause, 'conflict');
  r = closePart(s.board, 'A', { repo: s.repo, review, checked: 'second look' });
  assert.strictEqual((s.row().evidence.match(/checked=/g) || []).length, 1, s.row().evidence);
  assert.match(s.row().evidence, /checked=second look$/);
  const { pickCause } = require('../skills/orkestra/close_part.js');
  const id = pickCause('Committer identity unknown / *** Please tell me who you are.', []);
  assert.strictEqual(id.cause, 'git-identity');
  assert.match(id.hint, /not a conflict: git has no committer identity/);
  assert.strictEqual(pickCause('error: Your local changes would be overwritten', []).cause, 'git');
  assert.strictEqual(pickCause('CONFLICT (content)', ['a.txt']).hint, '');
});

// A -> A-2 -> A-3: the merge covers what review-A.json and review-A-2.json saw too, so the evidence names them.
function chained(s) {
  const c2 = commitOn(s, 'part-A', 'second'), c3 = commitOn(s, 'part-A', 'third');
  const revise = { ...ok, verdict: 'REVISE', blockers: ['a.txt:1 wrong'] };
  s.save('review-A.json', revise);
  reviewPackage(s.dir, 'A-2', s.sha, c2, s.repo); s.save('review-A-2.json', revise);
  reviewPackage(s.dir, 'A-3', c2, c3, s.repo);
  return { c3, final: s.save('review-A-3.json', ok) };
}

const runClose = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../skills/orkestra/close_part.js'), ...args], { encoding: 'utf8' });

test('a dry run reports the reviewed picks and leaves the board and HEAD unchanged', () => {
  const s = setup(), { c3, final } = chained(s);
  const board = fs.readFileSync(s.board), before = s.g('rev-parse', 'HEAD');
  const commits = s.g('rev-list', '--reverse', `${s.base}..${c3}`).split('\n');
  const run = runClose(s.board, '--dry-run', 'A', '--repo', s.repo, '--review', final, '--commit', c3);
  assert.strictEqual(run.status, 0, run.stderr || run.stdout);
  assert.deepStrictEqual(JSON.parse(run.stdout), {
    ok: true, part: 'A', commits, picked: commits.length, skipped_reviews: [], would_cherry_pick: commits, dry_run: true,
  });
  assert.deepStrictEqual(fs.readFileSync(s.board), board);
  assert.strictEqual(s.g('rev-parse', 'HEAD'), before);
});

test('a dry run rejects a high-risk part with one review without recording it', () => {
  const s = setup();
  fs.appendFileSync(s.board, '\n## Lane matrix\n| Part | parallel? | write surface | domain | risk |\n|---|---|---|---|---|\n| A | yes | a.txt | code | high |\n');
  const board = fs.readFileSync(s.board), before = s.g('rev-parse', 'HEAD');
  const args = [s.board, 'A', '--repo', s.repo, '--review', s.save('review-A.json', ok)];
  const dry = runClose(...args, '--dry-run');
  assert.deepStrictEqual(fs.readFileSync(s.board), board);
  assert.strictEqual(s.g('rev-parse', 'HEAD'), before);

  const real = runClose(...args);
  assert.strictEqual(real.status, 1, real.stderr || real.stdout);
  assert.match(JSON.parse(real.stdout).errors[0], /high risk: it needs two passing reviews/);
  assert.strictEqual(dry.status, real.status, dry.stderr || dry.stdout);
  assert.deepStrictEqual(JSON.parse(dry.stdout), { ...JSON.parse(real.stdout), dry_run: true });
});

test('closing a re-review chain records every earlier review as chain=', () => {
  const s = setup(), { c3, final } = chained(s);
  const r = closePart(s.board, 'A', { repo: s.repo, review: final, commits: [c3] });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(s.row().evidence, 'review=review-A-3.json chain=review-A.json>review-A-2.json');
});

test('a chain never counts as a second review for a high-risk part', () => {
  const s = setup(), { c3, final } = chained(s);
  fs.appendFileSync(s.board, '\n## Lane matrix\n| Part | parallel? | write surface | domain | risk |\n|---|---|---|---|---|\n| A | yes | a.txt | code | high |\n');
  const r = closePart(s.board, 'A', { repo: s.repo, review: final, commits: [c3] });
  assert.strictEqual(r.code, 1);
  assert.match(r.out.errors[0], /high risk: it needs two passing reviews/);
  assert.strictEqual(s.row().state, 'in-review');
});

test('a rerun replaces chain= and checked= instead of repeating them; a missing chain file fails the board', () => {
  const s = setup({ conflict: true }), { c3, final } = chained(s);
  for (const note of ['one', 'two']) {
    const r = closePart(s.board, 'A', { repo: s.repo, review: final, commits: [c3], checked: note });
    assert.strictEqual(r.out.cause, 'conflict');
  }
  assert.strictEqual(s.row().evidence, 'review=review-A-3.json chain=review-A.json>review-A-2.json checked=two');
  fs.unlinkSync(path.join(s.dir, 'review-A-2.json'));
  assert.match(boardCheck(s.board, 'A').errors.join(' / '), /chain review file not found: review-A-2\.json/);
});

test('a review already on the board whose folder name has a + is still one review', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.dir, 'r+1'));
  fs.writeFileSync(path.join(s.dir, 'r+1', 'review-A.json'), JSON.stringify(ok));
  fs.writeFileSync(s.board, fs.readFileSync(s.board, 'utf8').replace('|  |\n', '| review=r+1/review-A.json |\n'));
  const r = closePart(s.board, 'A', { repo: s.repo });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(s.row().state, 'merged');
});

test('a dry run reports the same skipped reviews as the real run, read from the board as merged', () => {
  const s = setup();
  fs.writeFileSync(s.board, fs.readFileSync(s.board, 'utf8').replace(`| ${s.sha} |  |`, `| ${s.sha} | review=skip: docs only |`));
  const dry = closePart(s.board, 'A', { repo: s.repo, dryRun: true });
  assert.strictEqual(dry.code, 0, JSON.stringify(dry.out));
  const real = closePart(s.board, 'A', { repo: s.repo });
  assert.strictEqual(real.code, 0, JSON.stringify(real.out));
  assert.deepStrictEqual(dry.out.skipped_reviews, real.out.skipped_reviews);
  assert.deepStrictEqual(dry.out.skipped_reviews, ['part A: review skipped — docs only']);
});

test('with no git identity anywhere, each commit is picked with its own author as the committer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-noid-'));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }).trim();
  const as = ['-c', 'user.name=Writer', '-c', 'user.email=writer@example.invalid'];
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); g('add', '-A'); g(...as, 'commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  g('checkout', '-qb', 'part-A');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'part A\n'); g('add', '-A'); g(...as, 'commit', '-qm', 'part A');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'part A, second writer\n'); g('add', '-A');
  g('-c', 'user.name=Second', '-c', 'user.email=second@example.invalid', 'commit', '-qm', 'part A 2');
  const sha = g('rev-parse', '--short', 'HEAD');
  g('checkout', '-q', 'main');
  g('config', 'user.useConfigOnly', 'true');            // and no identity in this repo's config
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-noid-b-')), board = path.join(jobDir, 'board.md');
  fs.writeFileSync(board, head + `| A | codex | in-review | b.txt | t | ${sha} |  |\n`);
  reviewPackage(jobDir, 'A', base, sha, dir);
  fs.writeFileSync(path.join(jobDir, 'review-A.json'), JSON.stringify(ok));
  const empty = path.join(jobDir, 'empty.gitconfig'); fs.writeFileSync(empty, '');
  const env = { ...process.env };
  for (const k of ['GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'EMAIL']) delete process.env[k];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' });
  let r;
  try { r = closePart(board, 'A', { repo: dir, review: path.join(jobDir, 'review-A.json') }); }
  finally { for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.match(r.out.committer, /each commit's author/);
  assert.deepStrictEqual(g('log', '-2', '--format=%cn <%ce>').split('\n'), ['Second <second@example.invalid>', 'Writer <writer@example.invalid>']);
  assert.strictEqual(g('status', '--porcelain'), '');
});

test('someone else\'s cherry-pick in progress is left alone, and a lost merge elsewhere stops the close before HEAD moves', () => {
  const s = setup({ conflict: true });
  const review = s.save('review-A.json', ok);
  try { s.g('cherry-pick', s.sha); } catch { }                               // the user's own pick, now in conflict
  fs.writeFileSync(path.join(s.repo, 'a.txt'), 'the user resolving it\n');
  let r = closePart(s.board, 'A', { repo: s.repo, review });
  assert.strictEqual(r.code, 2);
  assert.match(r.out.errors[0], /CHERRY_PICK_HEAD exists/);
  assert.strictEqual(fs.readFileSync(path.join(s.repo, 'a.txt'), 'utf8'), 'the user resolving it\n');
  s.g('cherry-pick', '--abort');

  const t = setup(), before = t.g('rev-parse', 'HEAD');
  fs.appendFileSync(t.board, `| Z | x | merged | z.txt | t | 1234567 | review=skip: gone |\n`);
  r = closePart(t.board, 'A', { repo: t.repo, review: t.save('review-A.json', ok) });
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.errors.some(e => /part Z/.test(e)), JSON.stringify(r.out));
  assert.strictEqual(t.g('rev-parse', 'HEAD'), before);
  assert.strictEqual(t.row().state, 'in-review');
});

test('a dry run refuses where the real close would: a pick in progress', () => {
  const s = setup({ conflict: true });
  const review = s.save('review-A.json', ok);
  try { s.g('cherry-pick', s.sha); } catch { }
  const r = closePart(s.board, 'A', { repo: s.repo, review, dryRun: true });
  assert.strictEqual(r.code, 2, JSON.stringify(r.out));
  assert.match(r.out.errors[0], /in progress/);
  s.g('cherry-pick', '--abort');
});

test('a review whose only cannot_verify is "tests not re-run" closes, and passes the run on to the verifier', () => {
  const s = setup();
  const note = 'node --test tests/*.test.js result not re-run';
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', { ...ok, cannot_verify: [note] }) });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.deepStrictEqual(r.out.verifier_runs, [note]);
  assert.strictEqual(s.row().state, 'merged');
});

const extra = { ...ok, spec: { missing: [], extra: ['aria label not in the brief'] } };

test('a part merged by hand with a failing review does not lock later closes; the audit still flags it', () => {
  const s = setup();
  s.save('review-X.json', extra);                                   // forced REVISE, merged by hand anyway
  fs.appendFileSync(s.board, `| X | codex | merged | x.txt | t | ${s.base.slice(0, 7)} | review=review-X.json |\n`);
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(s.row().state, 'merged');
  assert.match(r.out.other_parts.join('\n'), /part X: review review-X\.json is REVISE \(forced by spec\.extra\)/);
  const audit = boardCheck(s.board, null, s.repo);                  // no focus: every merged part in full
  assert.strictEqual(audit.code, 1);
  assert.match(audit.errors.join('\n'), /part X/);
});

test('another merged part whose commit is not on HEAD still holds the close', () => {
  const s = setup();
  s.g('checkout', '-qb', 'side'); fs.writeFileSync(path.join(s.repo, 'side.txt'), 'x'); s.g('add', '-A'); s.g('commit', '-qm', 'side');
  const lost = s.g('rev-parse', '--short', 'HEAD'); s.g('checkout', '-q', 'main');
  s.save('review-X.json', ok);
  fs.appendFileSync(s.board, `| X | codex | merged | side.txt | t | ${lost} | review=review-X.json |\n`);
  const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', ok) });
  assert.strictEqual(r.code, 1);
  assert.match(r.out.errors.join('\n'), /part X: commit .* is not on HEAD/);
  assert.strictEqual(s.row().state, 'in-review');
});

test('--accept-extra keeps a harmless spec.extra with its reason on the board; the audit honours it', () => {
  const s = setup(), review = s.save('review-A.json', extra);
  let r = closePart(s.board, 'A', { repo: s.repo, review });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.out.forced_by, ['spec.extra']);
  assert.match(r.out.hint, /--accept-extra/);
  r = closePart(s.board, 'A', { repo: s.repo, review, acceptExtra: 'needed so aria-labelledby resolves | user told' });
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(s.row().evidence, 'review=review-A.json accepted-extra=needed so aria-labelledby resolves / user told');
  assert.match(r.out.skipped_reviews.join('\n'), /part A: reviewer's spec\.extra kept — needed so aria-labelledby resolves/);
  const audit = boardCheck(s.board, null, s.repo);
  assert.strictEqual(audit.code, 0, JSON.stringify(audit));
});

test('--accept-extra never accepts blockers, goodhart, spec.missing or a REVISE verdict', () => {
  for (const bad of [
    { ...extra, blockers: ['a.txt:1 wrong'] },
    { ...extra, goodhart: ['test loosened'] },
    { ...ok, spec: { missing: ['item 3'], extra: ['x'] } },
    { ...extra, verdict: 'REVISE' },
  ]) {
    const s = setup(), before = s.g('rev-parse', 'HEAD');
    const r = closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', bad), acceptExtra: 'harmless' });
    assert.strictEqual(r.code, 1, JSON.stringify(bad));
    assert.strictEqual(r.out.hint, undefined);
    assert.strictEqual(s.g('rev-parse', 'HEAD'), before);
  }
});

test('--accept-extra needs a reason, and an accepted-extra note alone does not pass a review with blockers', () => {
  const s = setup();
  assert.strictEqual(closePart(s.board, 'A', { repo: s.repo, review: s.save('review-A.json', extra), acceptExtra: '  ' }).code, 2);
  s.save('review-X.json', { ...extra, blockers: ['real bug'] });
  fs.appendFileSync(s.board, `| X | codex | merged | x.txt | t | ${s.base.slice(0, 7)} | review=review-X.json accepted-extra=looked fine |\n`);
  const audit = boardCheck(s.board, null, s.repo);
  assert.strictEqual(audit.code, 1);
  assert.match(audit.errors.join('\n'), /part X: review review-X\.json is REVISE \(forced by blockers, spec\.extra\)/);
});
