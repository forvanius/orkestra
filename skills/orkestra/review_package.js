#!/usr/bin/env node
// Orkestra review package: writes a change to one file for the reviewer, so a diff never enters the
// conductor's context and the reviewer doesn't rebuild it by hand. Record BASE before the writer starts;
// for a re-review, BASE is the head the last review saw, so only the fix is reviewed.
//
//   node review_package.js <job dir> <name> <base> <head> [--repo <dir>] [--ruling "<text>" | --user "<words>"]
//
// Also writes diff-<name>.range.json ({base, head}, full SHAs): close_part.js merges exactly the commits
// the review saw, so a commit added after the review can't ride on its approval. A name holds one range.
// The review's result goes to review-<name>.json in the same folder; that is how the two are paired.
// Prints the diff file's path, nothing else. Exit: 0 = ok, 1 = board gate refused, 2 = bad input,
// 3 = invalid or conflicting range, 4 = legacy review-round limit (without a board).
const fs = require('fs'), path = require('path');
const { git, partsTable } = require('./board_check.js');

const LEGACY_MAX_REVIEWS = 3;

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function recordDecision(board, decision) {
  const text = fs.readFileSync(board, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const heading = lines.findIndex(line => /^##[ \t]+Decisions\b/i.test(line));
  if (heading < 0) {
    const separator = text.endsWith('\n') ? eol : eol + eol;
    fs.appendFileSync(board, `${separator}## Decisions${eol}${decision}${eol}`);
    return;
  }
  let end = lines.findIndex((line, i) => i > heading && /^#{1,2}[ \t]/.test(line));
  if (end < 0) end = lines.length;
  if (lines.slice(heading + 1, end).includes(decision)) return;
  while (end > heading + 1 && !lines[end - 1].trim()) end--;
  lines.splice(end, 0, decision);
  fs.writeFileSync(board, lines.join(eol));
}

function reviewPackage(jobDir, name, base, head, repo = process.cwd(), { ruling = null, user = null, userApproved = null } = {}) {
  if (!/^[\w.-]+$/.test(name || '')) return { code: 2, error: `bad name: ${name}` };
  const board = path.join(jobDir, 'board.md'), boardText = readOptional(board);
  let decision = null, legacyOverride = false;
  if (boardText !== null) {
    const names = (partsTable(boardText) || []).map(row => row.part);
    const suffix = name.match(/^(.+)-(\d+)$/);
    const exact = names.includes(name), part = exact ? name : suffix?.[1];
    if (!names.includes(part)) return { code: 1, error: `package name ${name} does not match a board part; board parts: ${names.join(', ') || '(none)'}` };
    const round = exact ? '1' : suffix[2].replace(/^0+(?=\d)/, '');
    if (Number(round) >= 3) {
      const modeLine = boardText.match(/^[ \t]*-[ \t]+Mode:[ \t]*([^\r\n]*)/im);
      const value = modeLine?.[1].trim();
      const mode = ['auto', 'checkpoints'].includes(value) ? value : 'ask';
      const words = (mode === 'auto' ? ruling : user)?.trim().replace(/[\r\n]+/g, ' ');
      const action = mode === 'auto' ? 'record a ruling with --ruling "<text>"' : 'ask the user and rerun with --user "<their words>"';
      if (!words) return { code: 1, error: `round cap: part ${part} came back REVISE twice — mode ${mode}: ${action}` };
      decision = mode === 'auto' ? `Ruling: review round ${round} for ${part} — ${words}` : `User: review round ${round} for ${part} — "${words}"`;
    }
  } else {
    // Jobs without a board retain the previous limit and its second-reviewer naming convention.
    const m = name.match(/^(.+?)-(\d+)(?:-[A-Za-z][\w-]*)?$/);
    legacyOverride = m && +m[2] > LEGACY_MAX_REVIEWS && fs.existsSync(path.join(jobDir, `diff-${m[1]}.range.json`));
    if (legacyOverride && !userApproved?.trim()) return { code: 4, error: `${name} would be review round ${m[2]}; the limit is ${LEGACY_MAX_REVIEWS}. Stop and ask the user: merge with the open findings recorded, fix them yourself, or drop the part. Only with their answer, rerun with --user-approved "<their words>"` };
  }
  for (const r of [base, head]) if (git(repo, ['cat-file', '-e', r + '^{commit}']).status !== 0) return { code: 2, error: `commit ${r} not found in ${repo}` };
  if (git(repo, ['merge-base', '--is-ancestor', base, head]).status !== 0) return { code: 3, error: `${base} is not an ancestor of ${head}` };
  const range = `${base}..${head}`, log = git(repo, ['log', '--oneline', range]).stdout;
  if (!log.trim()) return { code: 3, error: `empty range ${range}: nothing to review` };
  fs.mkdirSync(jobDir, { recursive: true });
  const file = path.join(jobDir, `diff-${name}.txt`);
  const sha = r => git(repo, ['rev-parse', r + '^{commit}']).stdout.trim();
  const rangeFile = path.join(jobDir, `diff-${name}.range.json`), want = { base: sha(base), head: sha(head) };
  // One name, one range: repackaging under the same name could pair an old review with new commits.
  const previous = readOptional(rangeFile);
  let was = null;
  if (previous !== null) {
    try { was = JSON.parse(previous); }
    catch { return { code: 3, error: `diff-${name}.range.json is not valid JSON` }; }
  }
  if (was && (was.base !== want.base || was.head !== want.head)) return { code: 3, error: `diff-${name}.range.json already holds ${String(was.base).slice(0, 9)}..${String(was.head).slice(0, 9)}: package the new commits as ${name}-2` };
  if (legacyOverride) want.user_approved = userApproved.trim();
  if (decision) recordDecision(board, decision);
  fs.writeFileSync(rangeFile, JSON.stringify(want) + '\n');
  fs.writeFileSync(file, `# Commits ${range}\n${log}\n# Files\n${git(repo, ['diff', '--stat', range]).stdout}\n# Diff\n${git(repo, ['diff', '-U10', range]).stdout}`);
  return { code: 0, file: file.replace(/\\/g, '/') };
}

if (require.main === module) {
  const a = process.argv.slice(2), take = k => { const i = a.indexOf(k); return i >= 0 ? (a.splice(i, 2)[1] || '') : null; };
  const repo = take('--repo') || process.cwd(), userApproved = take('--user-approved'), ruling = take('--ruling'), user = take('--user');
  if (a.length !== 4 || [ruling, user].some(value => value?.startsWith('--'))) { console.error('usage: node review_package.js <job dir> <name> <base> <head> [--repo <dir>] [--ruling "<text>" | --user "<words>"]'); process.exit(2); }
  let r;
  try { r = reviewPackage(a[0], a[1], a[2], a[3], repo, { userApproved, ruling, user }); }
  catch (e) { r = { code: 2, error: e.message.replace(/[\r\n]+/g, ' ') }; }
  if (r.error) console.error(r.error); else console.log(r.file);
  process.exit(r.code);
}

module.exports = { reviewPackage };
