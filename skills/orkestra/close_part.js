#!/usr/bin/env node
// Orkestra part closer: the whole end of a part in one conductor call, because every call re-reads
// the conductor's context. Gate the review, record it on the board, check the board, cherry-pick,
// mark the part merged, and confirm it is really on HEAD.
//
//   node close_part.js <board.md> <part> --repo <dir> [--review <review-x.json> ...] [--commit <sha> ...]
//
// --review  the reviewer's result, review-<name>.json; its path goes into the part's evidence as
//           review=<path>. Repeat it for a high-risk part (two passing reviews: review=a.json+b.json).
//           Omit it when the evidence already has review= (or review=skip: <reason>).
//           Each review must pair with the diff-<name>.range.json review_package.js wrote, and the
//           commits to merge must end at the head it reviewed (else exit 1, verdict UNREVIEWED).
// --checked what the conductor verified itself when the reviewer listed cannot_verify items.
// --commit  the part's commits, oldest first (default: the part's commit cell). Commits already on
//           HEAD are left alone. A failed cherry-pick is aborted and the board is not marked merged.
// --dry-run check the proposed close and report the planned picks without changing the board or repo.
// Exit: 0 = merged, 1 = the review or the board gate said no, 2 = bad input, 3 = cherry-pick failed.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const { extract, check } = require('./check_verdict.js');
const { locateTable, cells, boardCheck, onHead, git, reviewFiles } = require('./board_check.js');

const setRow = (lines, row, changes) => {
  const r = cells(lines[row.line]);
  for (const [i, v] of changes) r[i] = v;
  lines[row.line] = '| ' + r.join(' | ') + ' |';
};

function renderRow(text, part, build) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const t = locateTable(text), row = t.rows.find(r => r.part === part);
  setRow(t.lines, row, build(t, row));
  return t.lines.join(eol);
}

function saveRow(board, part, build) {
  fs.writeFileSync(board, renderRow(fs.readFileSync(board, 'utf8'), part, build));
}

// Check the proposed board text in place of the file; evidence paths still resolve from the board's directory.
function checkProposedBoard(board, part, text) {
  return boardCheck(board, part, null, text);
}

const findFile = (board, f) => [path.resolve(f), path.resolve(path.dirname(board), f)].find(x => fs.existsSync(x));

// The approval holds only for the commits the review saw: review-<name>.json pairs with the
// diff-<name>.range.json that review_package.js wrote (a re-review, <part>-2, starts where the last one
// stopped, so the range runs from the part's first package). The commits to merge must be exactly that
// range, in order; naming only its head merges the whole range.
const MERGED = /^(merged|birleşti|birlesti)$/i;
function checkBinding(board, part, files, shas, repo) {
  const full = s => git(repo, ['rev-parse', '--verify', '--quiet', s + '^{commit}']).stdout.trim();
  const dirs = f => [...new Set([path.dirname(f), path.dirname(path.resolve(board))])];
  const readRange = f => { try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); return r && r.base && r.head ? r : null; } catch { return null; } };
  const given = shas.map(full), errors = [];
  let merge = null, chainOf = [];
  for (const file of files) {
    const name = path.basename(file), m = name.match(/^review-(.+)\.json$/);
    if (!m) { errors.push(name + ': name it review-<name>.json so it pairs with diff-<name>.range.json'); continue; }
    // review-A-codex.json pairs with diff-A-codex.range.json, else with diff-A.range.json (a second reviewer of the same package)
    const names = m[1].split('-').map((_, i, p) => p.slice(0, p.length - i).join('-'));
    const rangeFile = names.flatMap(n => dirs(file).map(d => path.join(d, 'diff-' + n + '.range.json'))).find(f => fs.existsSync(f));
    if (!rangeFile) { errors.push(name + ': no diff-' + m[1] + '.range.json — package the change with review_package.js before the review'); continue; }
    if (fs.statSync(file).mtimeMs < fs.statSync(rangeFile).mtimeMs) { errors.push(name + ' is older than its package: the change was repackaged after this review, so review it again'); continue; }
    const range = readRange(rangeFile);
    if (!range) { errors.push(path.basename(rangeFile) + ' is not a valid range'); continue; }
    const first = dirs(file).map(d => readRange(path.join(d, 'diff-' + part + '.range.json'))).find(r => r && git(repo, ['merge-base', '--is-ancestor', r.head, range.head]).status === 0);
    // From the first package, every re-review (<part>-2, -3 …) must start where the one before stopped.
    if (first) {
      const chain = dirs(file).flatMap(d => fs.readdirSync(d).filter(f => new RegExp('^diff-' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d+\\.range\\.json$').test(f)).map(f => ({ ...readRange(path.join(d, f)), dir: d, name: f.replace(/^diff-(.*)\.range\.json$/, '$1') }))).filter(r => r.base && r.head);
      let at = first.head;
      const hops = [path.join(dirs(file).find(d => readRange(path.join(d, 'diff-' + part + '.range.json'))), 'review-' + part + '.json')];   // the review of each package on the way
      for (let hop = 0; at !== range.head && hop <= chain.length; hop++) { const next = chain.find(r => r.base === at); if (!next) break; at = next.head; hops.push(path.join(next.dir, 'review-' + next.name + '.json')); }
      if (at === range.head && !chainOf.length) {   // all but the last hop (its review is the review= file): every one must exist, so chain= is complete
        const earlier = hops.slice(0, -1), gone = earlier.filter(f => !fs.existsSync(f));
        for (const f of gone) errors.push(path.basename(f) + ': the review of ' + path.basename(f).replace(/^review-/, 'diff-').replace(/\.json$/, '.range.json') + ' is missing — the chain must name every review');
        if (gone.length) continue;
        chainOf = earlier;
      }
      if (at !== range.head) { errors.push(name + ': nothing reviewed the commits after ' + at.slice(0, 9) + ' — package each re-review from the head the last review saw'); continue; }
    }
    const base = first ? first.base : range.base;
    const want = git(repo, ['rev-list', '--reverse', '--no-merges', base + '..' + range.head]).stdout.trim().split('\n').filter(Boolean);
    const list = given.length === 1 && given[0] === range.head ? want : given;
    if (list.join() === want.join()) { merge = merge || list; continue; }
    const short = x => (x || '?').slice(0, 9);
    for (const [i, g] of given.entries()) if (!want.includes(g)) errors.push('commit ' + shas[i] + ' is not in what ' + name + ' reviewed' + (g === given[given.length - 1] ? ': review the new commits first' : ''));
    for (const w of want) if (!given.includes(w)) errors.push(name + ' reviewed ' + short(w) + ' as part of the change, but it is not being merged');
    if (!errors.length) errors.push('pass the commits ' + name + ' reviewed in order: ' + want.map(short).join(' '));
  }
  return errors.length ? { error: { code: 1, out: { ok: false, part, verdict: 'UNREVIEWED', errors } } } : { shas: merge, chain: chainOf };
}

function gateReview(board, part, reviews, checked, chain, record, runs = []) {
  const rels = [];
  for (const review of reviews) {
    const file = findFile(board, review);
    if (!file) return { code: 2, out: { ok: false, part, errors: [`review file not found: ${review}`] } };
    const v = extract(fs.readFileSync(file, 'utf8')), r = check(v);
    if (r.errors.length) return { code: 1, out: { ok: false, part, review, verdict: 'REVISE', errors: r.errors } };
    if (r.final !== 'APPROVE') return { code: 1, out: { ok: false, part, review, verdict: 'REVISE', forced_by: r.forced, blockers: v.blockers, goodhart: v.goodhart, spec: v.spec } };
    // Only what the conductor must decide holds the close; "tests not re-run" notes go to the verifier.
    if (r.cannotVerify.length && !checked) return { code: 1, out: { ok: false, part, review, verdict: 'NEEDS_CHECK', cannot_verify: r.cannotVerify } };
    runs.push(...r.verifierRuns);
    rels.push(path.relative(path.dirname(board), file).replace(/\\/g, '/'));
  }
  const rel = rels.join('+'), links = chain.map(f => path.relative(path.dirname(board), f).replace(/\\/g, '/')).join('>');
  const note = (links ? ` chain=${links}` : '') + (checked ? ` checked=${checked.replace(/\|/g, '/')}` : '');
  record((t, row) => {
    const ev = row.evidence.replace(/\s*checked=.*$/, '').replace(/\s*chain=[^\s|]*/, '');   // a rerun replaces the notes, never repeats them
    return [[t.c.evidence, (/(?:review|inceleme)\s*=/i.test(ev) ? ev.replace(/(review|inceleme)\s*=\s*[^\s,;|]+/i, `$1=${rel}`) : `${ev} review=${rel}`.trim()) + note]];
  });
  return null;
}

// Not every failed pick is a conflict: name the real cause so nobody resolves a conflict that isn't there.
function pickCause(why, conflicts) {
  const cause = conflicts.length ? 'conflict' : /identity unknown|tell me who you are/i.test(why) ? 'git-identity' : 'git';
  const hint = { conflict: '', 'git-identity': ' — not a conflict: git has no committer identity here and the retry with each commit\'s author failed too', git: ' — not a conflict: fix the git error and rerun' }[cause];
  return { cause, hint };
}

// Many machines have no git identity (no user.name/email anywhere). The writer's commits already carry one,
// so each commit is picked with its own author as the committer, for this run only: git config is the
// user's, never changed here, and nobody else's name is borrowed.
function pickAsAuthors(repo, shas) {
  for (const s of shas) {
    const [name, email] = git(repo, ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '-1', '--format=%an%x00%ae', s]).stdout.trim().split('\0');
    const r = spawnSync('git', ['-C', repo, 'cherry-pick', s], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
    if (r.status !== 0) return r;
  }
  return { status: 0 };
}

function closePart(board, part, { repo = process.cwd(), review = null, commits = [], checked = null, dryRun = false } = {}) {
  if (!fs.existsSync(board)) return { code: 2, out: { ok: false, errors: [`board not found: ${board}`] } };
  const text = fs.readFileSync(board, 'utf8'), t = locateTable(text);
  if (!t) return { code: 2, out: { ok: false, errors: ['no parts table (needs part, state and evidence columns)'] } };
  const row = t.rows.find(r => r.part === part);
  if (!row) return { code: 2, out: { ok: false, errors: [`part "${part}" is not on the board`] } };
  if (t.c.commit < 0) return { code: 2, out: { ok: false, part, errors: ['the parts table has no commit column'] } };
  if (git(repo, ['rev-parse', '--git-dir']).status !== 0) return { code: 2, out: { ok: false, part, errors: [`not a git repo: ${repo}`] } };
  if (MERGED.test(row.state)) {   // a rerun: nothing to do, but the merge must still be on HEAD
    const e = onHead(repo, row.commit);
    return e ? { code: 1, out: { ok: false, part, errors: [`part ${part} is marked merged, but ${e}`] } } : { code: 0, out: { ok: true, part, already_merged: true, commits: row.commit.split(/\s+/).filter(Boolean) } };
  }
  let shas = commits.length ? commits : (row.commit.match(/\b[0-9a-f]{7,40}\b/gi) || []);
  if (!shas.length) return { code: 2, out: { ok: false, part, errors: ['no commits: pass --commit or fill the commit cell'] } };

  const reviews = [].concat(review || []);
  let chain = [];
  const files = reviews.length ? reviews.map(f => findFile(board, f) || f) : reviewFiles(row, path.dirname(board)).map(f => path.resolve(path.dirname(board), f));
  if (files.length) {
    for (const s of shas) if (git(repo, ['cat-file', '-e', s + '^{commit}']).status !== 0) return { code: 2, out: { ok: false, part, errors: [`commit ${s} not found in ${repo}`] } };
    const missing = files.find(f => !fs.existsSync(f));
    if (missing) return { code: 2, out: { ok: false, part, errors: [`review file not found: ${missing}`] } };
    const bound = checkBinding(board, part, files, shas, repo);
    if (bound.error) return bound.error;
    shas = bound.shas; chain = bound.chain;
  }
  let proposed = text;
  const runs = [];   // reviewers' "tests not re-run" notes: the verifier's runs, reported, never holding the close
  if (reviews.length) {
    const record = dryRun ? build => { proposed = renderRow(text, part, build); } : build => saveRow(board, part, build);
    const failed = gateReview(board, part, reviews, checked, chain, record, runs);
    if (failed) return failed;
  }
  const gate = dryRun ? checkProposedBoard(board, part, proposed) : boardCheck(board, part);
  if (gate.code) return { code: gate.code, out: { ok: false, part, errors: gate.errors } };

  const todo = shas.filter(s => onHead(repo, s));
  for (const s of todo) if (git(repo, ['cat-file', '-e', s + '^{commit}']).status !== 0) return { code: 2, out: { ok: false, part, errors: [`commit ${s} not found in ${repo}`] } };
  // Someone else's merge, cherry-pick, revert or rebase in progress is theirs: aborting it would throw
  // their work away. A paused multi-commit pick may leave only the sequencer folder, so look for it too.
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const busy = ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'].find(r => git(repo, ['rev-parse', '-q', '--verify', r]).status === 0)
    || ['sequencer', 'rebase-merge', 'rebase-apply'].find(d => fs.existsSync(path.join(gitDir, d)));
  if (busy) return { code: 2, out: { ok: false, part, errors: [`${busy} exists: a merge, cherry-pick, revert or rebase is in progress in ${repo}; finish or abort it yourself, then rerun`] } };
  // Before touching HEAD: every other merged part must still be on it, or the final check would fail
  // after this part's commits were already picked.
  const before = boardCheck(board, null, repo);
  if (before.code) return { code: before.code, out: { ok: false, part, errors: before.errors } };
  if (dryRun) {
    // The same final check a real run makes, on the board as it would read after the merge: this part
    // marked merged. Its picked commits exist only after the cherry-pick, so HEAD is checked for the
    // other merged rows (the board as it is) and the reviews for all of them (the proposed board).
    const merged = renderRow(proposed, part, (tb) => [[tb.c.state, tb.turkish ? 'birleşti' : 'merged'], [tb.c.commit, shas.join(' ')]]);
    const onHeadNow = boardCheck(board, null, repo), after = boardCheck(board, null, null, merged);
    const errors = [...onHeadNow.errors, ...after.errors];
    if (errors.length) return { code: Math.max(onHeadNow.code, after.code), out: { ok: false, part, errors } };
    return { code: 0, out: { ok: true, part, commits: shas, picked: todo.length, skipped_reviews: after.skips, would_cherry_pick: todo, ...(runs.length ? { verifier_runs: runs } : {}) } };
  }
  let committer = null;
  if (todo.length) {
    const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    // Back to where we started: abort our pick in progress, then drop any commits already picked.
    const undo = () => {
      git(repo, ['cherry-pick', '--abort']);
      if (git(repo, ['rev-parse', 'HEAD']).stdout.trim() === head) return null;
      const r = git(repo, ['reset', '-q', '--keep', head]);
      return r.status === 0 ? null : `could not move HEAD back to ${head.slice(0, 9)} (${(r.stderr || '').trim().split('\n')[0]}); run: git reset --keep ${head}`;
    };
    let pick = git(repo, ['cherry-pick', ...todo]);
    if (pick.status !== 0 && pickCause((pick.stderr || pick.stdout), []).cause === 'git-identity') {
      const stuck = undo();
      if (stuck) return { code: 3, out: { ok: false, part, cause: 'git', errors: [stuck] } };
      pick = pickAsAuthors(repo, todo);
      if (pick.status === 0) committer = 'each commit\'s author (no git identity configured here)';
    }
    if (pick.status !== 0) {
      const why = (pick.stderr || pick.stdout).trim().split('\n').slice(0, 5).join(' / ');
      const conflicts = git(repo, ['diff', '--name-only', '--diff-filter=U']).stdout.trim().split('\n').filter(Boolean);
      const stuck = undo();
      const { cause, hint } = pickCause(why, conflicts);
      return { code: 3, out: { ok: false, part, cause, errors: [`cherry-pick failed and was aborted: ${why}${hint}`, ...(stuck ? [stuck] : [])], conflicts } };
    }
  }
  const fresh = todo.length ? git(repo, ['log', '--format=%h', '-n', String(todo.length)]).stdout.trim().split('\n').reverse() : [];
  const finalShas = shas.map(s => todo.includes(s) ? fresh[todo.indexOf(s)] : s);
  saveRow(board, part, (tb) => [[tb.c.state, tb.turkish ? 'birleşti' : 'merged'], [tb.c.commit, finalShas.join(' ')]]);

  const after = boardCheck(board, null, repo);
  if (after.code) return { code: after.code, out: { ok: false, part, errors: after.errors } };
  return { code: 0, out: { ok: true, part, commits: finalShas, picked: todo.length, skipped_reviews: after.skips, ...(committer ? { committer } : {}), ...(runs.length ? { verifier_runs: runs } : {}) } };
}

if (require.main === module) {
  const a = process.argv.slice(2), take = k => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : null; };
  const repo = take('--repo') || process.cwd(), checked = take('--checked'), commits = [], review = [];
  for (let c = take('--commit'); c; c = take('--commit')) commits.push(c);
  for (let r = take('--review'); r; r = take('--review')) review.push(r);
  const dryRunIndex = a.indexOf('--dry-run'), dryRun = dryRunIndex >= 0;
  if (dryRun) a.splice(dryRunIndex, 1);
  if (a.length !== 2) {
    const usage = 'usage: node close_part.js <board.md> <part> --repo <dir> [--review <review-x.json> ...] [--checked "<what you checked>"] [--commit <sha> ...]';
    if (dryRun) console.log(JSON.stringify({ ok: false, errors: [usage], dry_run: true }));
    else console.error(usage);
    process.exit(2);
  }
  const r = closePart(a[0], a[1], { repo, review, commits, checked, dryRun });
  console.log(JSON.stringify(dryRun ? { ...r.out, dry_run: true } : r.out));
  process.exit(r.code);
}

module.exports = { closePart, pickCause };
