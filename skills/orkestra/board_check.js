#!/usr/bin/env node
// Orkestra merge gate: no part is merged without a passing independent review on the board.
//
//   node board_check.js <board.md>                 check every merged part
//   node board_check.js <board.md> --merge <part>  run before merging <part>: it must pass too
//   node board_check.js <board.md> --handoff       run before a handoff: can a new session pick this up?
//   --repo <dir>   the repo merged into (default: current folder)
//
// Each checked row's evidence cell must hold `review=<result.json>` (path relative to the board),
// and that file must pass check_verdict.js as APPROVE. A part with no code to review may say
// `review=skip: <reason>` — allowed, but printed so the conductor tells the user. A part the lane matrix
// marks high risk needs two passing reviews: `review=a.json+b.json`.
// A merged row's commit cell must name commits that are really on HEAD of --repo (directly or as a
// cherry-pick with the same patch), or say `none` with `review=skip: <reason>` for a no-code part.
// A review forced to REVISE by spec.extra alone passes when the evidence holds `accepted-extra=<reason>`
// (close_part.js --accept-extra writes it); it is printed so the conductor tells the user.
// Exit: 0 = ok, 1 = a part lacks a passing review or its merged commit is not on HEAD,
// 2 = no board, no parts table or not a git repo.
// Turkish boards work too: Parça / durum / kanıt, `birleşti`, `inceleme=`.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const { extract, check } = require('./check_verdict.js');

const MERGED = /^(merged|birleşti|birlesti)$/i;
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());

// The parts table with its column indexes; each row also knows its line, so a tool can rewrite it.
function locateTable(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const head = cells(lines[i]).map(h => h.toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const c = { part: col(/^(part|parça|parca)/), state: col(/^(state|durum)/), evidence: col(/^(evidence|kanıt|kanit)/), commit: col(/^commit/) };
    if (c.part < 0 || c.state < 0 || c.evidence < 0) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const r = cells(lines[j]);
      rows.push({ line: j, part: r[c.part] || '', state: (r[c.state] || '').split(/\s|\(/)[0], evidence: r[c.evidence] || '', commit: c.commit >= 0 ? r[c.commit] || '' : '' });
    }
    return { lines, c, rows, turkish: /^durum/.test(head[c.state]) };
  }
  return null;
}

function partsTable(text) {
  const t = locateTable(text);
  return t && t.rows.map(({ line, ...row }) => row);
}

// `review=a.json` or, for a high-risk part, `review=a.json+b.json` (paths relative to the board).
const REVIEW_RE = /(?:review|inceleme)\s*=\s*(skip|atla)\s*:?\s*([^|]*)|(?:review|inceleme)\s*=\s*([^\s,;|]+)/i;
function reviewFiles(row, dir) {
  const m = row.evidence.match(REVIEW_RE);
  if (!m || !m[3]) return [];
  const value = m[3];
  if (dir !== undefined && fs.statSync(path.join(dir, value), { throwIfNoEntry: false })?.isFile()) return [value];
  return value.split('+').filter(Boolean);
}

// The conductor's recorded reason for keeping what a reviewer listed under spec.extra (nothing else).
const acceptedExtra = evidence => { const m = evidence.match(/accepted-extra\s*=\s*(?!=)([^|]*?)\s*(?=\bchecked=|$)/i); return m && m[1].trim() ? m[1].trim() : null; };

function reviewOf(row, dir) {
  const m = row.evidence.match(REVIEW_RE);
  if (!m) return { ok: false, why: 'no review= entry in evidence' };
  if (m[1]) return m[2].trim() ? { ok: true, skip: m[2].trim() } : { ok: false, why: 'review=skip needs a reason' };
  const files = reviewFiles(row, dir);
  if (!files.length) return { ok: false, why: 'review= names no file' };
  const link = row.evidence.match(/chain\s*=\s*([^\s,;|]+)/i);   // earlier reviews of a re-review chain: must exist, never counted
  if (link) for (const name of link[1].split('>').filter(Boolean)) if (!fs.existsSync(path.resolve(dir, name))) return { ok: false, why: `chain review file not found: ${name}` };
  const accepted = acceptedExtra(row.evidence);
  let extras = 0;
  const seen = new Set();
  for (const name of files) {
    const file = path.resolve(dir, name);
    if (!fs.existsSync(file)) return { ok: false, why: `review file not found: ${name}` };
    const real = fs.realpathSync(file).toLowerCase();
    if (seen.has(real)) return { ok: false, why: `review ${name} is listed twice: two reviews must be two files` };
    seen.add(real);
    const r = check(extract(fs.readFileSync(file, 'utf8')));
    if (r.errors.length) return { ok: false, why: `no valid verdict in ${name}: ${r.errors.join('; ')}` };
    if (r.final !== 'APPROVE' && !(accepted && r.forced.join() === 'spec.extra')) return { ok: false, why: `review ${name} is ${r.final}${r.forced.length ? ' (forced by ' + r.forced.join(', ') + ')' : ''}` };
    if (r.final !== 'APPROVE') extras++;
  }
  return { ok: true, count: files.length, ...(extras ? { accepted } : {}) };
}

// Risk per part from the lane matrix (the table with part, write surface and risk columns).
const HIGH_RISK = /^(high|yüksek|yuksek)\b/i;
function risks(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const head = cells(lines[i]).map(h => h.toLowerCase()), p = head.findIndex(h => /^(part|parça|parca)/.test(h)), k = head.findIndex(h => /^risk/.test(h));
    if (p < 0 || k < 0 || !head.some(h => /^(write surface|yazma)/.test(h))) continue;
    const out = {};
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) { const r = cells(lines[j]); out[r[p] || ''] = r[k] || ''; }
    return out;
  }
  return {};
}

const git = (repo, args, input) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
const patchIds = (repo, diff) => new Set(git(repo, ['patch-id', '--stable'], diff).stdout.split('\n').filter(Boolean).map(l => l.split(' ')[0]));

// Is every commit named in the cell on HEAD — as an ancestor, or cherry-picked (same patch-id)?
function onHead(repo, cell) {
  const shas = cell.match(/\b[0-9a-f]{7,40}\b/gi);
  if (!shas) return 'commit cell is empty — write the merged commit';
  let headIds = null;
  for (const sha of shas) {
    if (git(repo, ['cat-file', '-e', sha + '^{commit}']).status !== 0) return `commit ${sha} not found in ${repo}`;
    if (git(repo, ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0) continue;
    const id = [...patchIds(repo, git(repo, ['show', sha]).stdout)][0];
    headIds = headIds || patchIds(repo, git(repo, ['log', '-p', '-n', '500', 'HEAD']).stdout);
    if (!id || !headIds.has(id)) return `commit ${sha} is not on HEAD (merge/cherry-pick did not happen or failed)`;
  }
  return null;
}

function mergedCommitError(repo, row) {
  if (row.commit === 'none') {
    const review = row.evidence.match(REVIEW_RE);
    const skip = row.evidence.match(/\b(?:review|inceleme)\s*=\s*(?:skip|atla)\s*:\s*\S/i);
    return skip && review.index === skip.index ? null : 'commit none requires review=skip: <reason>';
  }
  if (!row.commit) return 'commit cell is empty — write the merged commit';
  return repo ? onHead(repo, row.commit) : null;
}

// text: optional board contents to check instead of the file's (a proposed board); evidence paths
// still resolve from boardFile's directory.
// focus: the part being closed. A review problem of another merged part is then reported under `others`
// instead of holding this close (one hand-merged part must not lock every later part); their commits must
// still be on HEAD. Without focus every merged part is checked in full, as the audit and handoff need.
function boardCheck(boardFile, mergePart, repo = null, text = null, focus = null) {
  if (text === null && !fs.existsSync(boardFile)) return { code: 2, errors: [`board not found: ${boardFile}`], skips: [] };
  if (text === null) text = fs.readFileSync(boardFile, 'utf8');
  const rows = partsTable(text), risk = risks(text);
  if (!rows) return { code: 2, errors: ['no parts table (needs part, state and evidence columns)'], skips: [] };
  const errors = [], skips = [], others = [];
  if (repo && git(repo, ['rev-parse', '--git-dir']).status !== 0) return { code: 2, errors: [`not a git repo: ${repo} (pass --repo)`], skips: [] };
  if (mergePart && !rows.some(r => r.part === mergePart)) errors.push(`part "${mergePart}" is not on the board`);
  for (const row of rows) {
    if (!MERGED.test(row.state) && row.part !== mergePart) continue;
    const r = reviewOf(row, path.dirname(boardFile));
    if (!r.ok) (focus && row.part !== focus ? others : errors).push(`part ${row.part}: ${r.why}`);
    // checked when a part merges; parts merged before this rule keep their single review
    else if (row.part === mergePart && HIGH_RISK.test(risk[row.part] || '') && (r.skip || r.count < 2)) errors.push(`part ${row.part} is high risk: it needs two passing reviews (review=a.json+b.json), has ${r.skip ? "a skip" : r.count}`);
    else if (r.skip) skips.push(`part ${row.part}: review skipped — ${r.skip}`);
    else if (r.accepted) skips.push(`part ${row.part}: reviewer's spec.extra kept — ${r.accepted}`);
    if (MERGED.test(row.state)) { const e = mergedCommitError(repo, row); if (e) errors.push(`part ${row.part}: ${e}`); }
  }
  return { code: errors.length ? 1 : 0, errors, skips, ...(others.length ? { others } : {}) };
}

const KNOWN_STATE = /^(ready|running|in-review|blocked|merged|hazır|hazir|çalışıyor|calisiyor|incelemede|engelli|birleşti|birlesti)$/i;
const RUNNING = /^(running|çalışıyor|calisiyor)$/i;
const NEXT_FIELDS = [['Next action', /^[ \t]*-?[ \t]*(?:next action|sıradaki eylem)[ \t]*:[ \t]*(.*)$/im], ['Open decisions', /^[ \t]*-?[ \t]*(?:open decisions|açık kararlar)[ \t]*:[ \t]*(.*)$/im], ['Read first', /^[ \t]*-?[ \t]*(?:read first|önce oku)[ \t]*:[ \t]*(.*)$/im]];

// Can a new session pick this up? A handoff that loses the context costs more than it saves.
function handoffCheck(boardFile, repo = null) {
  const base = boardCheck(boardFile, null, repo);
  if (base.code === 2) return base;
  const text = fs.readFileSync(boardFile, 'utf8'), errors = [...base.errors];
  if (!/^##[ \t]*(next session|sonraki oturum)/im.test(text)) errors.push('no Next session section on the board');
  else for (const [name, re] of NEXT_FIELDS) { const m = text.match(re); if (!m || !m[1].trim()) errors.push(`Next session: "${name}" is empty (write "none" if there is nothing)`); }
  for (const row of partsTable(text)) {
    if (!KNOWN_STATE.test(row.state)) errors.push(`part ${row.part}: state "${row.state}" is not current`);
    else if (RUNNING.test(row.state)) errors.push(`part ${row.part} is still running: let it finish or record where it stopped`);
  }
  return { code: errors.length ? 1 : 0, errors, skips: base.skips };
}

if (require.main === module) {
  const args = process.argv.slice(2), i = args.indexOf('--merge');
  const mergePart = i >= 0 ? args.splice(i, 2)[1] : null;
  const h = args.indexOf('--handoff'), handoff = h >= 0;
  if (handoff) args.splice(h, 1);
  const k = args.indexOf('--repo'), repo = k >= 0 ? args.splice(k, 2)[1] : process.cwd();
  if (!args[0]) { console.error('usage: node board_check.js <board.md> [--merge <part> | --handoff] [--repo <dir>]'); process.exit(2); }
  const r = handoff ? handoffCheck(args[0], repo) : boardCheck(args[0], mergePart, repo);
  console.log(JSON.stringify({ ok: r.code === 0, errors: r.errors, skipped_reviews: r.skips }));
  process.exit(r.code);
}

module.exports = { partsTable, locateTable, cells, boardCheck, handoffCheck, onHead, mergedCommitError, git, reviewFiles, acceptedExtra };
