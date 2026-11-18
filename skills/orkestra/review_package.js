#!/usr/bin/env node
// Orkestra review package: writes a change to one file for the reviewer, so a diff never enters the
// conductor's context and the reviewer doesn't rebuild it by hand. Record BASE before the writer starts;
// for a re-review, BASE is the head the last review saw, so only the fix is reviewed.
//
//   node review_package.js <job dir> <name> <base> <head> [--repo <dir>]
//
// Also writes diff-<name>.range.json ({base, head}, full SHAs): close_part.js merges exactly the commits
// the review saw, so a commit added after the review can't ride on its approval. A name holds one range.
// The review's result goes to review-<name>.json in the same folder; that is how the two are paired.
// Prints the diff file's path, nothing else. Exit: 0 = ok, 2 = bad input, 3 = empty range, base is not
// an ancestor of head (the writer committed elsewhere), or <name> already holds a different range;
// 4 = <part>-4 or later without --user-approved (the review-round limit).
const fs = require('fs'), path = require('path');
const { git } = require('./board_check.js');

// Rule 8 as a gate, not a memory: a part gets its review and at most two re-reviews (<part>-2 after the
// writer's fix, <part>-3 after the conductor's own diagnosis). A fourth review only with the user's
// word, quoted; a video pilot ran eight rounds, each on a narrower edge case of the last fix.
const MAX_REVIEWS = 3;

function reviewPackage(jobDir, name, base, head, repo = process.cwd(), { userApproved = null } = {}) {
  if (!/^[\w.-]+$/.test(name || '')) return { code: 2, error: `bad name: ${name}` };
  // A re-review is <part>-N (a second reviewer may add a suffix: <part>-N-codex) of a part already packaged.
  const m = name.match(/^(.+?)-(\d+)(?:-[A-Za-z][\w-]*)?$/);
  const round = m && fs.existsSync(path.join(jobDir, `diff-${m[1]}.range.json`)) ? m[2] : null;
  if (round && +round > MAX_REVIEWS && !(userApproved && userApproved.trim())) return { code: 4, error: `${name} would be review round ${round}; the limit is ${MAX_REVIEWS}. Stop and ask the user: merge with the open findings recorded, fix them yourself, or drop the part. Only with their answer, rerun with --user-approved "<their words>"` };
  for (const r of [base, head]) if (git(repo, ['cat-file', '-e', r + '^{commit}']).status !== 0) return { code: 2, error: `commit ${r} not found in ${repo}` };
  if (git(repo, ['merge-base', '--is-ancestor', base, head]).status !== 0) return { code: 3, error: `${base} is not an ancestor of ${head}` };
  const range = `${base}..${head}`, log = git(repo, ['log', '--oneline', range]).stdout;
  if (!log.trim()) return { code: 3, error: `empty range ${range}: nothing to review` };
  fs.mkdirSync(jobDir, { recursive: true });
  const file = path.join(jobDir, `diff-${name}.txt`);
  const sha = r => git(repo, ['rev-parse', r + '^{commit}']).stdout.trim();
  const rangeFile = path.join(jobDir, `diff-${name}.range.json`), want = { base: sha(base), head: sha(head) };
  // One name, one range: repackaging under the same name could pair an old review with new commits.
  let was = null; try { was = JSON.parse(fs.readFileSync(rangeFile, 'utf8')); } catch { }
  if (was && (was.base !== want.base || was.head !== want.head)) return { code: 3, error: `diff-${name}.range.json already holds ${String(was.base).slice(0, 9)}..${String(was.head).slice(0, 9)}: package the new commits as ${name}-2` };
  if (round && +round > MAX_REVIEWS) want.user_approved = userApproved.trim();
  fs.writeFileSync(rangeFile, JSON.stringify(want) + '\n');
  fs.writeFileSync(file, `# Commits ${range}\n${log}\n# Files\n${git(repo, ['diff', '--stat', range]).stdout}\n# Diff\n${git(repo, ['diff', '-U10', range]).stdout}`);
  return { code: 0, file: file.replace(/\\/g, '/') };
}

if (require.main === module) {
  const a = process.argv.slice(2), take = k => { const i = a.indexOf(k); return i >= 0 ? (a.splice(i, 2)[1] || '') : null; };
  const repo = take('--repo') || process.cwd(), userApproved = take('--user-approved');
  if (a.length !== 4) { console.error('usage: node review_package.js <job dir> <name> <base> <head> [--repo <dir>] [--user-approved "<the user\'s words>"]'); process.exit(2); }
  const r = reviewPackage(a[0], a[1], a[2], a[3], repo, { userApproved });
  if (r.error) console.error(r.error); else console.log(r.file);
  process.exit(r.code);
}

module.exports = { reviewPackage };
