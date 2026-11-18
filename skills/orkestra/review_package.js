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
// an ancestor of head (the writer committed elsewhere), or <name> already holds a different range.
const fs = require('fs'), path = require('path');
const { git } = require('./board_check.js');

function reviewPackage(jobDir, name, base, head, repo = process.cwd()) {
  if (!/^[\w.-]+$/.test(name || '')) return { code: 2, error: `bad name: ${name}` };
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
  fs.writeFileSync(rangeFile, JSON.stringify(want) + '\n');
  fs.writeFileSync(file, `# Commits ${range}\n${log}\n# Files\n${git(repo, ['diff', '--stat', range]).stdout}\n# Diff\n${git(repo, ['diff', '-U10', range]).stdout}`);
  return { code: 0, file: file.replace(/\\/g, '/') };
}

if (require.main === module) {
  const a = process.argv.slice(2), i = a.indexOf('--repo'), repo = i >= 0 ? a.splice(i, 2)[1] : process.cwd();
  if (a.length !== 4) { console.error('usage: node review_package.js <job dir> <name> <base> <head> [--repo <dir>]'); process.exit(2); }
  const r = reviewPackage(a[0], a[1], a[2], a[3], repo);
  if (r.error) console.error(r.error); else console.log(r.file);
  process.exit(r.code);
}

module.exports = { reviewPackage };
