#!/usr/bin/env node
// Orkestra token meter: sums Claude Code transcript usage per agent and per model.
//
//   node usage_sum.js --here [--last N]                      sessions of the current folder (default: last 1)
//   node usage_sum.js <project-transcript-dir> <session-id> [<session-id> ...]
//   Either form accepts --budget <board.md> and --json.
//
// Transcripts live in ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl, subagents in
// <session-id>/subagents/. Codex usage is not in these files — read it from the Codex CLI output.
const fs = require('fs'), path = require('path'), os = require('os');

// Claude Code names a project's transcript folder by replacing every non-alphanumeric
// character of its absolute path with '-' (C:\Users\me\app -> C--Users-me-app).
function encodeProjectDir(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function projectDirFor(cwd, root = path.join(os.homedir(), '.claude', 'projects')) {
  const dir = path.join(root, encodeProjectDir(cwd));
  return fs.existsSync(dir) ? dir : null;
}

function latestSessions(dir, n = 1) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    .map(f => ({ id: f.slice(0, -6), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t).slice(0, n).map(s => s.id);
}

// `seen` is shared across files: streamed messages repeat their id, and a session continued after
// its context filled up starts with a copy of the previous session's messages — count each once.
function sum(file, seen = new Set()) {
  return sumFile(file, seen);
}

function sumFile(file, seen, scope) {
  const r = { in: 0, cw: 0, cr: 0, out: 0, n: 0, first: null, last: null, models: {} };
  if (!fs.existsSync(file)) return r;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (scope && typeof j.timestamp === 'string') {
      const ts = Date.parse(j.timestamp);
      if (Number.isFinite(ts)) {
        scope.first = Math.min(scope.first, ts);
        scope.last = Math.max(scope.last, ts);
      }
    }
    if (j.type !== 'assistant' || !j.message || !j.message.usage) continue;
    const id = j.message.id; if (id && seen.has(id)) continue; if (id) seen.add(id);
    const u = j.message.usage;
    r.in += u.input_tokens || 0; r.cw += u.cache_creation_input_tokens || 0;
    r.cr += u.cache_read_input_tokens || 0; r.out += u.output_tokens || 0; r.n++;
    const m = j.message.model || '?'; r.models[m] = (r.models[m] || 0) + 1;
    if (!r.first || j.timestamp < r.first) r.first = j.timestamp;
    if (!r.last || j.timestamp > r.last) r.last = j.timestamp;
  }
  return r;
}

function collect(proj, ids) {
  return collectRows(proj, ids);
}

function collectRows(proj, ids, scope) {
  const rows = [], seen = new Set();
  for (const sid of ids) {
    const main = sumFile(path.join(proj, sid + '.jsonl'), seen, scope);
    if (scope) scope.conductorReads += main.cr;
    rows.push({ sess: sid.slice(0, 8), name: 'MAIN (conductor)', r: main });
    const sd = path.join(proj, sid, 'subagents');
    if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd).filter(f => f.endsWith('.jsonl'))) {
      let d = f;
      try { d = JSON.parse(fs.readFileSync(path.join(sd, f.replace('.jsonl', '.meta.json')), 'utf8')).description || f; } catch {}
      rows.push({ sess: sid.slice(0, 8), name: d.slice(0, 38), r: sumFile(path.join(sd, f), seen, scope) });
    }
  }
  return rows;
}

function report(rows, print = true) {
  const T = { in: 0, cw: 0, cr: 0, out: 0, n: 0 }; const byModel = {};
  const M = x => (x / 1e6).toFixed(2) + 'M';
  for (const { sess, name, r } of rows) {
    if (!r.n) continue;
    for (const k in T) T[k] += r[k];
    if (!print) continue;
    const model = Object.keys(r.models).sort((a, b) => r.models[b] - r.models[a])[0];
    const bm = byModel[model] || (byModel[model] = { n: 0, cr: 0, cw: 0, out: 0, agents: 0 });
    bm.n += r.n; bm.cr += r.cr; bm.cw += r.cw; bm.out += r.out; bm.agents++;
    const mins = r.first ? ((new Date(r.last) - new Date(r.first)) / 60000).toFixed(0) : 0;
    console.log(sess, name.padEnd(40), model.padEnd(20), 'calls', String(r.n).padStart(4),
      'cacheR', M(r.cr).padStart(8), 'cacheW', M(r.cw).padStart(7), 'out', String(r.out).padStart(7), 'min', mins);
  }
  if (!print) return T;
  console.log('\nBY MODEL');
  for (const m in byModel) {
    const b = byModel[m];
    console.log(m.padEnd(22), 'agents', b.agents, 'calls', b.n, 'cacheR', M(b.cr), 'cacheW', M(b.cw), 'out', b.out);
  }
  console.log('TOTAL calls', T.n, 'cacheR', M(T.cr), 'cacheW', M(T.cw), 'in', T.in, 'out', T.out);
  return T;
}

function boardEstimates(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^##[ \t]+Budget[ \t]*$/.test(line));
  if (start < 0) return {};
  for (let i = start + 1; i < lines.length && !/^#{1,2}[ \t]/.test(lines[i]); i++) {
    const estimate = lines[i].match(/^[ \t]*-[ \t]+Estimate:[ \t]*(.*)$/)?.[1];
    if (estimate === undefined) continue;
    const fields = {};
    for (const [, key, value, unit] of estimate.matchAll(/(?:^|[ \t])(claude_reads|conductor|time)=(\d+(?:\.\d+)?|\.\d+)([Mh])(?=[ \t]|$)/g)) {
      const number = Number(value);
      if (Number.isFinite(number) && unit === (key === 'time' ? 'h' : 'M')) fields[key] = number;
    }
    return fields;
  }
  return {};
}

function budgetView(estimates, total, scope) {
  const budget = {};
  const spent = {
    claude_reads: total.cr / 1e6,
    conductor: scope.conductorReads / 1e6,
    time: Number.isFinite(scope.first) ? Number(((scope.last - scope.first) / 3_600_000).toFixed(1)) : 0,
  };
  for (const key of Object.keys(spent)) {
    const estimate = estimates[key];
    if (estimate === undefined) continue;
    budget[key] = { spent: spent[key], estimate };
    if (key !== 'time') budget[key].pct = estimate ? Math.round(100 * spent[key] / estimate) : null;
  }
  return budget;
}

function budgetLine(budget) {
  const fields = Object.entries(budget).map(([key, { spent, estimate, pct }]) => {
    if (key === 'time') return `time ${spent.toFixed(1)}h / ${estimate}h`;
    return `${key} ${spent.toFixed(2)}M / ${estimate}M (${pct === null ? 'n/a' : pct + '%'})`;
  });
  return 'budget: ' + (fields.length ? fields.join(', ') : 'no estimate on the board');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf('--json');
  const json = jsonAt >= 0;
  if (json) args.splice(jsonAt, 1);
  const budgetAt = args.indexOf('--budget');
  let scope, estimates;
  if (budgetAt >= 0) {
    const board = args.splice(budgetAt, 2)[1];
    if (!board || board.startsWith('--')) { console.error('--budget requires a board file'); process.exit(2); }
    let text;
    try { text = fs.readFileSync(board, 'utf8'); }
    catch (error) { console.error(`cannot read budget board (${error.code || error.name})`); process.exit(2); }
    estimates = boardEstimates(text);
    scope = { conductorReads: 0, first: Infinity, last: -Infinity };
  }
  let proj, ids;
  if (args[0] === '--here') {
    proj = projectDirFor(process.cwd());
    if (!proj) { console.error('no transcripts for ' + process.cwd() + ' (expected ~/.claude/projects/' + encodeProjectDir(process.cwd()) + ')'); process.exit(2); }
    const i = args.indexOf('--last');
    ids = latestSessions(proj, i >= 0 ? Math.max(1, parseInt(args[i + 1], 10) || 1) : 1);
    if (!ids.length) { console.error('no session transcripts in ' + proj); process.exit(2); }
    if (!json) console.log('project:', proj, '\nsessions:', ids.join(' '), '\n');
  } else {
    [proj, ...ids] = args;
  }
  if (!proj || !ids.length) {
    console.error('usage: node usage_sum.js --here [--last N] [--budget <board.md>] [--json]\n       node usage_sum.js <project-transcript-dir> <session-id> [<session-id> ...] [--budget <board.md>] [--json]');
    process.exit(2);
  }
  const rows = collectRows(proj, ids, scope);
  const total = report(rows, !json);
  const budget = scope && budgetView(estimates, total, scope);
  if (json) console.log(JSON.stringify({ rows, total, ...(budget && { budget }) }, null, 2));
  else if (budget) console.log(budgetLine(budget));
}

module.exports = { encodeProjectDir, projectDirFor, latestSessions, sum, collect };
