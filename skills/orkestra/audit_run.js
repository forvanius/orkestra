#!/usr/bin/env node
// Orkestra run auditor: reads Claude Code transcripts (read-only) and checks a finished run
// against the rules — model and effort routing, review gating, parallelism, conductor load,
// timing, risky commands and secrets in briefs.
//
//   node audit_run.js --here [--last N] [--codex-model M] [--json]
//   node audit_run.js <project-transcript-dir> <session-id> [...] [--codex-model M] [--json]
//
// Expected Codex model: --codex-model, else pluginConfigs["orkestra@orkestra"].options.codex_model
// from ~/.claude/settings.json. Exit: 0 no FAIL, 1 at least one FAIL, 2 bad input.
const fs = require('fs'), path = require('path'), os = require('os');
const { encodeProjectDir, projectDirFor, latestSessions, sum } = require('./usage_sum.js');
const { LIMIT: CTX_GROWTH_LIMIT, BOOT_CALLS } = require('../../hooks/handoff_guard.js');   // rule 1, same line as the hook

const MAX_PARALLEL_CLAUDE = 3;     // rule 6
// Token-shaped values only, so source code that merely names SECRET or holds a regex isn't flagged.
const SECRET = /(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)\s*[=:]\s*["']?[A-Za-z0-9_\-+]{16,})/;
const TEST_PATH = /(^|[\\/])(tests?|__tests__|fixtures?|mocks?|spec)[\\/]|[._-](test|spec|mock|fixture)s?\.\w+$/i;
// A real invocation starts a command segment; `codex exec --help` and mentions inside other commands don't count.
const CODEX_CALL = /(?:(?:^|[;&|(\n]|=\s*)\s*|guarded\.js["']?\s+codex\b[^\n;&|]*?\s--\s+)codex(?:\.cmd|\.ps1)?\s+exec\b(?![^\n;&|]*\s--?(?:help|h|version)\b)/;
const RISKY_GIT = /git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+(-f\b|--force)|checkout\s+--\s|branch\s+-D)/;
// Reading a background job's log/output by hand instead of waiting for its notice: a wait loop always
// counts; a single read counts only before that job's completion notice (reading the result after is fine).
const BG_FILE = /codex[^\s"'`]*\.log|[\\/]tasks[\\/][^\s"'`]+\.output/gi;
const READS = /\b(tail|Get-Content|cat|type|Select-String|Test-Path|grep)\b/i;
const WAIT_LOOP = /\b(until|while|for)\b[\s\S]*\b(sleep|Start-Sleep)\b/i;
// A heavy browser/smoke run (the script itself, not text in a brief), and markers of low priority.
const HEAVY = /(?:^|[;&|(\n]\s*)(?:\$env:\S+\s*;\s*|[A-Z_]+=\S+\s+)*(?:python3?|py|pytest|npx)\s+(?:-\S+\s+)*\S*(?:smoke|playwright|e2e)\S*|Start-Process\b[^\n]*(?:smoke|playwright)|guarded\.js["']?\s+heavy\b/im;
const LOW_PRIO = /guarded\.js["']?\s+heavy\b|BelowNormal|Idle|PriorityClass|-Priority\b|\bnice\s|start\s+\/(?:low|belownormal)/i;
const OUR_REVIEWER = /^(orkestra:)?reviewer$/i;    // not impeccable-finish-reviewer and the like
const OUR_ADVISOR = /^(orkestra:)?advisor$/i;
// A filled-in reason on the board; the template's own empty line doesn't count.
const CONSULT_SKIPPED = /(?:consultation skipped \(reason\)|danışma atlandı \(gerekçe\)):[ \t]*[^\s|]/i;
// The conductor reading files, logs or diffs through the shell (rule 1). Writing a file by heredoc is not reading.
const SHELL_READ = /\b(cat|Get-Content|tail|head|Select-String|sed|grep|rg)\b|\bgit\s+(show|diff|log)\b/;

function load(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const content = e => (e.message && Array.isArray(e.message.content)) ? e.message.content : [];

// A subagent resumed by the conductor (SendMessage) keeps one transcript: each new prompt starts a new run.
// The time limit is per run, so the longest run counts, not first-to-last across all of them.
function runsOf(entries) {
  const runs = []; let cur = null;
  for (const e of entries) {
    if (!e.timestamp) continue;
    // A prompt from the conductor, not a system reminder the harness injects mid-run.
    const text = typeof (e.message || {}).content === 'string' ? e.message.content : content(e).filter(c => c.type === 'text').map(c => c.text || '').join('');
    const prompt = e.type === 'user' && !e.isMeta && !content(e).some(c => c.type === 'tool_result') && text.trim() !== '' && !/^\s*<system-reminder>/.test(text);
    if (!cur || (prompt && cur.n)) { cur = { first: e.timestamp, last: e.timestamp, n: 0 }; runs.push(cur); }
    cur.last = e.timestamp; cur.n++;
  }
  return runs;
}
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text || '').join('\n') : '';

function index(entries) {
  const uses = [], results = {}, done = {};
  for (const e of entries) {
    if (e.type === 'assistant') for (const c of content(e)) if (c.type === 'tool_use')
      uses.push({ id: c.id, name: c.name, input: c.input || {}, ts: e.timestamp });
    if (e.type === 'user') for (const c of content(e)) if (c.type === 'tool_result')
      results[c.tool_use_id] = { ts: e.timestamp, text: textOf(c.content) };
    if (e.type === 'queue-operation' && typeof e.content === 'string' && e.content.includes('<task-notification>')) {
      const id = (e.content.match(/<tool-use-id>([^<]+)</) || [])[1];
      if (id) done[id] = { ts: e.timestamp, status: (e.content.match(/<status>([^<]+)</) || [])[1], text: String(e.content) };
    }
  }
  return { uses, results, done };
}

function parseCodex(cmd) {
  const m = cmd.match(/(?:^|\s)(?:-m|--model)[\s=]+("?)([^\s"]+)\1/);
  const s = cmd.match(/(?:^|\s)(?:-s|--sandbox)[\s=]+([\w-]+)/);
  const ef = cmd.match(/model_reasoning_effort\s*=\s*"?(\w+)/);
  const sandbox = s ? s[1] : null, schema = /--output-schema/.test(cmd), image = /(?:^|\s)(?:-i|--image)\s/.test(cmd);
  const role = sandbox === 'read-only' ? (schema ? 'reviewer' : /consult/i.test(cmd) ? 'consult' : 'diagnosis') : image ? 'image' : sandbox === 'workspace-write' ? 'writer' : 'other';
  return { model: m ? m[2] : null, effort: ef ? ef[1] : null, sandbox, schema, role };
}

function codexTokens(text) {
  const m = (text || '').match(/tokens used\s*\n?\s*([\d.,]+)/i);
  return m ? parseInt(m[1].replace(/[.,]/g, ''), 10) : null;
}

const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;
const isBg = u => !!u.input.run_in_background;
// Heredoc / here-string bodies are briefs and reports, not commands.
const stripDocs = cmd => cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '').replace(/@["'][\s\S]*?["']@/g, '');
const isHeavy = cmd => HEAVY.test(stripDocs(cmd));
const norm = p => p.replace(/\\/g, '/').toLowerCase();
const isShellRead = cmd => !CODEX_CALL.test(cmd) && !/<</.test(cmd) && !/@["']/.test(cmd) && !/check_verdict\.js|board_check\.js|close_part\.js/.test(cmd) && SHELL_READ.test(cmd);

// Background output files of one transcript -> when their job finished (undefined = never notified).
function bgFiles({ uses, results, done }) {
  const m = new Map();
  for (const u of uses) {
    if (!isBg(u)) continue;
    const r = results[u.id], fin = done[u.id] && done[u.id].ts;
    const out = r && r.text.match(/Output is being written to:\s*(\S+?\.output)/);
    if (out) m.set(norm(out[1]), fin);
    for (const x of String(u.input.command || '').matchAll(/>\s*["']?([^\s"'>]+\.(?:log|txt|output))/g)) m.set(norm(x[1]), fin);
  }
  return m;
}

function isPoll(u, files) {
  const cmd = String(u.input.command || '');
  if (CODEX_CALL.test(cmd) || !READS.test(cmd)) return false;
  const hits = [...cmd.matchAll(BG_FILE)].map(x => norm(x[0]));
  if (!hits.length) return false;
  if (WAIT_LOOP.test(cmd)) return true;
  return hits.some(h => [...files].some(([f, fin]) => f.endsWith(h) && (!fin || u.ts < fin)));
}

// A background command's result only says where its output goes; the verdict is in that file.
function withBgOutput(text) {
  const m = (text || '').match(/Output is being written to:\s*(\S+?\.output)/);
  if (!m) return text || '';
  try { return text + '\n' + fs.readFileSync(m[1], 'utf8'); } catch { return text; }
}

function pluginOption(name, home = os.homedir()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    return (((j.pluginConfigs || {})['orkestra@orkestra'] || {}).options || {})[name] || null;
  } catch { return null; }
}
const expectedCodexModel = home => pluginOption('codex_model', home);

// The board line that says why reviews stayed with one vendor, or null. It must be a stated decision
// (a Ruling, or a line naming same-vendor review), say why the OTHER vendor (`missing`: codex or claude)
// was not used — out of quota, unavailable, or a project rule in AGENTS.md — and not be a prohibition.
const DECIDED = /\bruling\b|same[- ]vendor|aynı (?:firma|sağlayıcı|satıcı)/i;
// A reason the vendor was NOT used: its quota or limit was hit, it was unavailable, or a project rule.
// "has quota" or "is available" is not a reason.
const WHY = /out of (?:quota|limit|credits)|quota (?:exhausted|reached|used up|full|hit)|(?:no|over|over the) (?:quota|limit)|limit (?:reached|hit|exceeded)|unavailable|not available|could not run|kota (?:doldu|bitti|aşıldı)|kullanılmadı|agents\.md/i;
const FORBIDS = /prohibit|forbid|not allowed|must not|never allowed|yasak/i;
function sameVendorReasonOnBoard(paths, missing) {
  const names = missing === 'codex' ? /\bcodex\b/i : /\bclaude\b/i;
  for (const p of paths) {
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const line = text.split(/\r?\n/).find(l => DECIDED.test(l) && names.test(l) && WHY.test(l) && !FORBIDS.test(l));
    if (line) return line.trim().slice(0, 160);
  }
  return null;
}

// How many parts the board's lane matrix marks as code (domain code/debug/data); null when no board says.
function codePartsOnBoard(paths) {
  let best = null;
  for (const p of paths) {
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/), cellsOf = l => l.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim().toLowerCase());
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim().startsWith('|')) continue;
      const head = cellsOf(lines[i]), d = head.findIndex(h => /^(domain|alan)/.test(h));
      if (d < 0 || !head.some(h => /^(write surface|yazma)/.test(h))) continue;
      let n = 0;
      for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) if (/^(code|kod|debug|data|veri)\b/.test(cellsOf(lines[j])[d] || '')) n++;
      best = Math.max(best || 0, n);
      break;
    }
  }
  return best;
}

// Codex's own session files hold what background runs hide from Claude transcripts: model, effort,
// tokens and the plan's quota. Matched by time window only, so other Codex work in that window counts too.
function codexRollouts(first, last, home = os.homedir()) {
  const out = { runs: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, byModel: {}, byEffort: {}, quota: null };
  const from = new Date(first).getTime(), to = new Date(last).getTime();
  let quotaAt = '';
  const walk = dir => {
    let names; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const f = path.join(dir, n), st = fs.statSync(f);
      if (st.isDirectory()) { walk(f); continue; }
      if (!n.endsWith('.jsonl') || st.mtimeMs < from) continue;
      let start = null, usage = null, model = '?', effort = '?';
      for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!l) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        const p = j.payload || {};
        if (!start && j.timestamp) start = j.timestamp;
        if (j.type === 'turn_context') { model = p.model || model; effort = p.effort || effort; }
        if (p.type === 'token_count') {
          if (p.info && p.info.total_token_usage) usage = p.info.total_token_usage;
          if (p.rate_limits && p.rate_limits.primary && j.timestamp > quotaAt && new Date(j.timestamp).getTime() <= to) {
            quotaAt = j.timestamp;
            out.quota = { windowPct: p.rate_limits.primary.used_percent, weeklyPct: p.rate_limits.secondary ? p.rate_limits.secondary.used_percent : null };
          }
        }
      }
      if (!start || new Date(start).getTime() > to || new Date(start).getTime() < from - 3600_000) continue;
      out.runs++; out.byEffort[effort] = (out.byEffort[effort] || 0) + 1;
      if (usage) {
        const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
        out.inputTokens += usage.input_tokens || 0; out.cachedTokens += usage.cached_input_tokens || 0; out.outputTokens += usage.output_tokens || 0;
        out.byModel[model] = (out.byModel[model] || 0) + tokens;
      }
    }
  };
  walk(path.join(home, '.codex', 'sessions'));
  return out;
}

function maxOverlap(intervals) {
  const ev = [];
  for (const [a, b] of intervals) { ev.push([new Date(a).getTime(), 1]); ev.push([new Date(b).getTime(), -1]); }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, max = 0; for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  return max;
}

function audit(proj, ids, opts = {}) {
  const F = [], add = (level, rule, msg) => F.push({ level, rule, msg });
  const facts = { sessions: ids, codex: [], subagents: [], conductor: {} };
  const expModel = opts.codexModel || null;
  let mainCr = 0, subCr = 0, first = null, last = null, maxCtx = 0, maxGrowth = 0, overCtx = 0;
  const efforts = {}, images = [], secrets = [], risky = [], bgIntervals = [], subIntervals = [];
  let consultsCodex = 0, consultsClaude = 0, consultSkipped = false;
  let reviews = 0, claudeReviews = 0, gates = 0, revises = 0, boardWrites = 0, boardChecks = 0, designNote = false, polls = 0, heavy = 0, heavyNormal = 0, shellCalls = 0, shellReads = 0;
  const scanCmd = (u, files) => { const cmd = String(u.input.command || ''); if (isPoll(u, files)) polls++; if (isHeavy(cmd)) { heavy++; if (!LOW_PRIO.test(cmd)) heavyNormal++; } };
  // A session continued after its context filled up starts with a copy of the previous one:
  // count every message and tool call once across all sessions.
  const seenMsg = new Set(), seenUsage = new Set(), seenUse = new Set();
  let unguarded = 0, handoffChecks = 0, handoffsSaid = 0, finalReviews = 0;
  const boardPaths = new Set();

  // One Codex call, whether the conductor or a section lead started it.
  const noteCodex = (u, cmd, results, done) => {
    const c = parseCodex(cmd), r = results[u.id];
    // guarded.js refused to start it (quota, no slot): not a Codex run, not a review
    if ([r && r.text, (done[u.id] || {}).text].some(t => t && /"started"\s*:\s*false/.test(withBgOutput(t)))) { facts.codexRefused = (facts.codexRefused || 0) + 1; return; }
    const end = isBg(u) ? (done[u.id] || {}).ts : (r || {}).ts;
    c.minutes = end ? +mins(u.ts, end).toFixed(1) : null;
    c.tokens = codexTokens(r && r.text);
    // Returned at once with no token line: the run was detached or its output went to a file, so this
    // transcript can't time it. Say so instead of reporting 0 (the Codex files' totals still count it).
    if (c.minutes != null && c.minutes < 0.05 && c.tokens == null) { c.minutes = null; c.untimed = true; }
    c.background = isBg(u);
    facts.codex.push(c);
    if (!/guarded\.js/.test(cmd)) unguarded++;
    if (c.role === 'reviewer') { reviews++; if (/review-final/.test(cmd)) finalReviews++; }
    if (c.role === 'consult') consultsCodex++;
    if (!c.model) add('FAIL', 'codex-model', `codex ${c.role} call without -m`);
    else if (/[$<{]/.test(c.model)) add('FAIL', 'codex-model', `model placeholder not substituted: "${c.model}"`);
    else if (expModel && c.model !== expModel && c.model !== opts.codexModelLight && c.model !== opts.codexModelDesign) add('WARN', 'codex-model', `codex ${c.role} used "${c.model}", expected "${expModel}"`);
    if (!c.effort) add('WARN', 'codex-effort', `codex ${c.role} call without explicit effort`);
    if (c.role === 'reviewer' && !c.schema) add('WARN', 'review-schema', 'read-only review without --output-schema');
    if (/danger/.test(c.sandbox || '')) add('FAIL', 'codex-sandbox', `codex ran with sandbox "${c.sandbox}"`);
    if (c.minutes && c.minutes > 25 && c.role === 'writer') add('WARN', 'time-limit', `codex writer ran ${c.minutes} min (limit ~25)`);
  };

  for (const sid of ids) {
    const main = load(path.join(proj, sid + '.jsonl'));
    const { uses, results, done } = index(main), files = bgFiles({ uses, results, done });
    let calls = 0, base = 0;
    for (const e of main) {
      if (e.timestamp) { if (!first || e.timestamp < first) first = e.timestamp; if (!last || e.timestamp > last) last = e.timestamp; }
      if (e.type === 'assistant' && content(e).some(c => c.type === 'text' && /\/orkestra:orkestra continue from/.test(c.text || ''))) handoffsSaid++;
      if (e.type === 'assistant' && e.message && e.message.usage) {
        const id = e.message.id; if (id && seenMsg.has(id)) continue; if (id) seenMsg.add(id);
        const u = e.message.usage, ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (ctx && (++calls <= BOOT_CALLS || ctx < base)) base = ctx;
        maxCtx = Math.max(maxCtx, ctx); maxGrowth = Math.max(maxGrowth, ctx - base); if (ctx - base > CTX_GROWTH_LIMIT) overCtx++;
        if (e.effort) efforts[e.effort] = (efforts[e.effort] || 0) + 1;
      }
    }
    mainCr += sum(path.join(proj, sid + '.jsonl'), seenUsage).cr;

    const agentTypes = {}, agentModels = {};
    for (const u of uses) {
      if (seenUse.has(u.id)) continue; seenUse.add(u.id);
      const raw = JSON.stringify(u.input);
      const sec = raw.match(SECRET);
      if (sec) secrets.push({ test: TEST_PATH.test(u.input.file_path || ''), msg: `${u.name}${u.input.file_path ? ' ' + path.basename(u.input.file_path) : ''}: ${sec[0].slice(0, 4)}… (${sec[0].length} chars, masked)` });
      if (u.name === 'Read' && /\.(png|jpe?g|gif|webp)$/i.test(u.input.file_path || '')) images.push(u.input.file_path);
      if (/^(Write|Edit)$/.test(u.name) && /(board|pano)\.md$/i.test(u.input.file_path || '')) {
        boardWrites++; boardPaths.add(u.input.file_path); if (/^[ \t]*-[ \t]*(goal|hedef|amaç)[ \t]*:[ \t]*\S/im.test(String(u.input.content || u.input.new_string || ''))) designNote = true;   // a filled-in Goal, not the template's empty heading
        if (CONSULT_SKIPPED.test(String(u.input.content || u.input.new_string || ''))) consultSkipped = true;
      }
      if (/^(Agent|Task)$/.test(u.name)) {
        const d = u.input.description || '';
        agentTypes[d] = u.input.subagent_type || 'general';
        if (u.input.model) agentModels[d] = u.input.model;
        if (OUR_REVIEWER.test(u.input.subagent_type || '')) { claudeReviews++; reviews++; if (/final/i.test(d)) finalReviews++; }
        if (OUR_ADVISOR.test(u.input.subagent_type || '')) consultsClaude++;
      }
      const cmd = (u.name === 'Bash' || u.name === 'PowerShell') ? String(u.input.command || '') : '';
      if (!cmd) continue;
      if (RISKY_GIT.test(cmd)) risky.push(cmd.match(RISKY_GIT)[0]);
      scanCmd(u, files);
      shellCalls++; if (isShellRead(cmd)) shellReads++;
      // The board is written by the scripts the skill prescribes, or by the shell, not only by Write/Edit.
      const boardFile = (cmd.match(/[^\s"'<>|;]*(?:board|pano)\.md/i) || [])[0];
      if (/new_job\.js|close_part\.js/.test(cmd) || (boardFile && /(>>?|sed\s+-i|Set-Content|Add-Content|Out-File)[^\n]*(?:board|pano)\.md/i.test(cmd))) boardWrites++;
      if (boardFile) boardPaths.add(boardFile);
      if (/new_job\.js/.test(cmd)) { const out = (results[u.id] || {}).text || ''; const m = out.match(/"board"\s*:\s*"([^"]+)"/); if (m) boardPaths.add(m[1]); }
      if (/board_check\.js[^\n]*--handoff/.test(cmd)) handoffChecks++;
      else if (/board_check\.js|close_part\.js/.test(cmd)) boardChecks++;
      if (/check_verdict\.js|close_part\.js[^\n]*--review/.test(cmd)) {
        gates++; const r = results[u.id]; if (r && /"verdict"\s*:\s*"REVISE"/.test(withBgOutput(r.text))) revises++;
      }
      if (isBg(u) && done[u.id]) bgIntervals.push([u.ts, done[u.id].ts]);
      if (CODEX_CALL.test(cmd)) noteCodex(u, cmd, results, done);
    }

    const sd = path.join(proj, sid, 'subagents');
    if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd).filter(f => f.endsWith('.jsonl'))) {
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(sd, f.replace('.jsonl', '.meta.json')), 'utf8')); } catch {}
      const r = sum(path.join(sd, f), seenUsage); if (!r.n) continue;
      // Subagents run the smoke tests and wait on jobs too: their commands count for CPU and polling.
      const subEntries = load(path.join(sd, f)), subIdx = index(subEntries), subFiles = bgFiles(subIdx);
      for (const u of subIdx.uses) {
        if (seenUse.has(u.id)) continue; seenUse.add(u.id);
        if (u.name !== 'Bash' && u.name !== 'PowerShell') continue;
        scanCmd(u, subFiles);
        const subCmd = String(u.input.command || '');
        if (CODEX_CALL.test(subCmd)) noteCodex(u, subCmd, subIdx.results, subIdx.done);
      }
      subCr += r.cr;   // parallelism counts each run, not the idle time between a run and its resumption
      for (const x of runsOf(subEntries)) subIntervals.push([x.first, x.last]);
      const model = Object.keys(r.models).sort((a, b) => r.models[b] - r.models[a])[0];
      const desc = meta.description || f, type = meta.agentType || meta.subagent_type || agentTypes[desc] || '?';
      const runs = runsOf(subEntries), longest = runs.reduce((a, x) => Math.max(a, mins(x.first, x.last)), 0);
      const sub = { description: desc, type, model, calls: r.n, readsM: +(r.cr / 1e6).toFixed(2), minutes: r.first ? +mins(r.first, r.last).toFixed(1) : 0, runs: runs.length, longestRun: +longest.toFixed(1) };
      facts.subagents.push(sub);
      // A model chosen on the Agent call is a lane decision, not a routing error. Agents that ship
      // their own model (design reviewers and the like) are not orkestra's to route.
      const chosen = !!agentModels[desc], isAdvisor = OUR_ADVISOR.test(type), isReviewer = OUR_REVIEWER.test(type), isLead = /section-lead/i.test(type), ours = isReviewer || isAdvisor || isLead || /worker|isci|designer|researcher|verifier|dogrulayici|general|^\?$/i.test(type);
      if (/opus/i.test(model) && ours && !chosen) add('FAIL', 'subagent-model', `subagent "${desc}" ran on ${model} (strongest model as subagent)`);
      if (!chosen && /verifier|dogrulayici/i.test(type) && !/haiku/i.test(model)) add('WARN', 'subagent-model', `verifier "${desc}" ran on ${model}, expected Haiku`);
      if (!chosen && (isReviewer || isAdvisor || isLead || /worker|isci|designer|researcher/i.test(type)) && !/sonnet/i.test(model)) add('WARN', 'subagent-model', `${isReviewer ? 'reviewer' : isAdvisor ? 'advisor' : isLead ? 'section lead' : /designer/i.test(type) ? 'designer' : /researcher/i.test(type) ? 'researcher' : 'worker'} "${desc}" ran on ${model}, expected Sonnet`);
      if (sub.longestRun > 25 && /worker|isci/i.test(type)) add('WARN', 'time-limit', `worker "${desc}" ran ${sub.longestRun} min in one go (limit ~25)`);
    }
  }

  const par = maxOverlap(subIntervals), bgPar = maxOverlap(bgIntervals);
  if (par > MAX_PARALLEL_CLAUDE) add('FAIL', 'parallel', `${par} Claude subagents ran at once (max ${MAX_PARALLEL_CLAUDE})`);
  if (bgPar > 3) add('WARN', 'cpu', `${bgPar} background commands overlapped — check CPU load`);
  if (overCtx) add('WARN', 'conductor-context', `${overCtx} conductor calls more than ${CTX_GROWTH_LIMIT / 1000} K above the session's start (max growth ${Math.round(maxGrowth / 1000)} K, max context ${Math.round(maxCtx / 1000)} K) — handoff to a new session was due`);
  if (images.length) add('WARN', 'conductor-reads', `conductor opened ${images.length} image(s) itself`);
  if (shellCalls >= 20 && shellReads / shellCalls > 0.4) add('WARN', 'conductor-reads', `${shellReads} of ${shellCalls} conductor shell calls read files, logs or diffs — routine reads go to the verifier; reads a decision rests on are fine and noted on the board`);
  if (handoffsSaid && !handoffChecks) add('WARN', 'handoff', 'a handoff was announced but board_check.js --handoff never ran — the new session may lose context');
  if (polls > 5) add('WARN', 'polling', `background logs/outputs were read by hand ${polls} times (conductor or subagents) — start long runs in the background and wait for one completion notice`);
  if (heavyNormal) add('WARN', 'cpu', `${heavyNormal} of ${heavy} smoke/browser test run(s) started at normal priority — start them BelowNormal (the machine is the user's)`);
  const writes = facts.codex.filter(c => c.role === 'writer').length;
  const sectionLeads = facts.subagents.filter(s => /section-lead/i.test(s.type)).length;    // one review covers a whole section
  if (unguarded) add('WARN', 'guarded', `${unguarded} of ${facts.codex.length} Codex runs started without guarded.js — no enforced time limit or quota check`);
  if (writes && reviews === 0) add('FAIL', 'review', `Codex wrote code ${writes} time(s) but no independent read-only review was found`);
  else if (writes > reviews && !sectionLeads) add('WARN', 'review', `${writes} Codex writes but only ${reviews} review(s) — every written part needs one before merge`);
  if (writes && !boardChecks) add('WARN', 'gate', 'code was written but board_check.js / close_part.js never ran — merges were not gated on the board');
  const workers = facts.subagents.filter(s => /worker|isci/i.test(s.type)).length;
  // A same-vendor review is allowed when the board says why (Codex out of quota, a project rule that keeps
  // Codex for hard problems): then it is a recorded decision, not a slip, and gets no warning.
  const codexOnlyWhy = sameVendorReasonOnBoard([...boardPaths], 'claude'), claudeOnlyWhy = sameVendorReasonOnBoard([...boardPaths], 'codex');
  facts.sameVendorReason = claudeOnlyWhy || codexOnlyWhy;
  if (writes >= 2 && reviews && !claudeReviews && !codexOnlyWhy) add('WARN', 'routing', `all ${reviews} reviews of Codex-written code came from Codex — the reviewer should be from the other vendor (orkestra:reviewer)`);
  if (writes + workers >= 3 && !consultSkipped && !(consultsCodex && consultsClaude)) add('WARN', 'consult', consultsCodex || consultsClaude
    ? `the plan was consulted with only one advisor (${consultsCodex ? 'Codex' : 'Claude'}) — two vendors, neither seeing the other`
    : `${writes + workers} parts were written without consulting advisors and no skip reason is on the board`);
  // The rule is "2+ parts wrote code": when the board's lane matrix says which parts are code, count those.
  const codeParts = codePartsOnBoard([...boardPaths]), written = codeParts == null ? writes + workers : codeParts;
  if (written >= 2 && !finalReviews) add('WARN', 'final-review', `${written} ${codeParts == null ? 'parts were written' : 'parts wrote code'} but no final review looked at how they fit together`);
  // The other direction of the vendor rule: Claude-written code reviewed by Claude only.
  if (workers && claudeReviews && reviews === claudeReviews && !claudeOnlyWhy) add('WARN', 'routing', `all ${reviews} reviews came from Claude while Claude workers wrote parts — Claude-written code should get a Codex review (fine if Codex was out of quota or a project rule says so: write the reason on the board)`);
  if (writes >= 4 && !workers) add('WARN', 'routing', `all ${writes} written parts went to Codex and none to a Claude worker — check that each lane chose its model`);
  if (gates < reviews) add('WARN', 'gate', `${reviews} review(s) but only ${gates} check_verdict.js run(s) — some verdicts were read by eye`);
  if ((writes || facts.subagents.length) && !boardWrites) add('WARN', 'board', 'run without a board file (the board is required and doubles as the handoff note)');
  for (const s of secrets) add(s.test ? 'WARN' : 'FAIL', 'secret', `possible secret in a tool input${s.test ? ' (test/fixture file — check it is fake)' : ''}: ${s.msg}`);
  for (const g of [...new Set(risky)]) add('WARN', 'git', `destructive git command used: ${g}`);
  const high = facts.codex.filter(c => c.effort === 'high' || c.effort === 'xhigh').length;
  if (facts.codex.length >= 4 && high / facts.codex.length > 0.5) add('WARN', 'codex-effort', `${high}/${facts.codex.length} Codex calls on high effort — reserve it for hard or critical parts`);

  const total = mainCr + subCr;
  facts.conductor = { readsM: +(mainCr / 1e6).toFixed(2), sharePct: total ? Math.round(100 * mainCr / total) : 0, maxContextK: Math.round(maxCtx / 1000), maxGrowthK: Math.round(maxGrowth / 1000), efforts, imagesOpened: images.length, shellCalls, shellReads };
  facts.wallMinutes = first ? +mins(first, last).toFixed(1) : 0;
  if (opts.codexHome && first) facts.codexRollouts = codexRollouts(first, last, opts.codexHome);
  facts.consults = { codex: consultsCodex, claude: consultsClaude, skipped: consultSkipped };
  facts.sectionLeads = sectionLeads; facts.unguarded = unguarded; facts.handoffChecks = handoffChecks; facts.finalReviews = finalReviews;
  facts.reviews = reviews; facts.claudeReviews = claudeReviews; facts.gates = gates; facts.revisesGated = revises; facts.maxParallelClaude = par;
  facts.boardWrites = boardWrites; facts.boardChecks = boardChecks; facts.heavyRuns = heavy; facts.heavyNormal = heavyNormal; facts.designNote = designNote; facts.polls = polls;
  facts.codexTokens = facts.codex.reduce((a, c) => a + (c.tokens || 0), 0);
  return { facts, findings: F };
}

function render({ facts: f, findings }) {
  const L = [];
  L.push(`# Orkestra run audit`, ``, `Sessions: ${f.sessions.join(', ')} · wall clock ${f.wallMinutes} min`, ``);
  L.push(`## Conductor`, `- reads ${f.conductor.readsM} M (${f.conductor.sharePct}% of Claude reads) · max context ${f.conductor.maxContextK} K, grown ${f.conductor.maxGrowthK} K · effort ${JSON.stringify(f.conductor.efforts)} · images opened ${f.conductor.imagesOpened} · shell reads ${f.conductor.shellReads}/${f.conductor.shellCalls}`, ``);
  const untimed = f.codex.filter(c => c.untimed).length;
  L.push(`## Codex (${f.codex.length} calls, ${f.codexTokens} tokens visible in Claude transcripts${untimed ? `; ${untimed} not timed here (detached or output to a file), see Codex's own files below` : ''})`);
  const x = f.codexRollouts;
  if (x) L.push(`- Codex's own files, every run on this machine in the window: ${x.runs} runs · ${((x.inputTokens + x.outputTokens) / 1e6).toFixed(2)} M tokens (${((x.cachedTokens) / 1e6).toFixed(2)} M cached input) · models ${JSON.stringify(x.byModel)} · effort ${JSON.stringify(x.byEffort)}${x.quota ? ` · quota used: ${x.quota.windowPct}% of 5 h, ${x.quota.weeklyPct}% of week` : ''}`);
  for (const c of f.codex) L.push(`- ${c.role.padEnd(9)} model=${c.model || '—'} effort=${c.effort || '—'} sandbox=${c.sandbox || '—'}${c.schema ? ' schema' : ''} ${c.minutes != null ? c.minutes + ' min' : '? min'}${c.background ? ' (bg)' : ''}${c.tokens ? ' ' + c.tokens + ' tok' : ''}`);
  L.push(``, `## Claude subagents (max ${f.maxParallelClaude} in parallel; ${f.claudeReviews} Claude reviews)`);
  for (const s of f.subagents) L.push(`- ${s.description} [${s.type}] ${s.model} · ${s.calls} calls · ${s.readsM} M · ${s.minutes} min${s.runs > 1 ? ` in ${s.runs} runs, longest ${s.longestRun}` : ''}`);
  L.push(``, `## Process`, `- plan consults: Codex ${f.consults.codex}, Claude ${f.consults.claude}${f.consults.skipped ? ' (skipped with a reason)' : ''} · section leads ${f.sectionLeads} · unguarded Codex runs ${f.unguarded} · reviews ${f.reviews} · gated ${f.gates} · REVISE via gate ${f.revisesGated} · board writes ${f.boardWrites} · board checks ${f.boardChecks} · design note ${f.designNote ? 'yes' : 'no'} · log polls ${f.polls} · smoke runs ${f.heavyRuns} (normal priority ${f.heavyNormal})`, ``);
  L.push(`## Findings`);
  if (!findings.length) L.push('- none');
  for (const x of ['FAIL', 'WARN', 'INFO']) for (const y of findings.filter(z => z.level === x)) L.push(`- **${x}** [${y.rule}] ${y.msg}`);
  L.push(``, `Not visible here: test results inside Codex's sandbox and anything done outside these sessions.`);
  return L.join('\n');
}

if (require.main === module) {
  const a = process.argv.slice(2), flag = k => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : null; };
  const json = a.includes('--json'); if (json) a.splice(a.indexOf('--json'), 1);
  const codexModel = flag('--codex-model') || expectedCodexModel();
  let proj, ids;
  if (a[0] === '--here') {
    const n = parseInt(flag('--last'), 10) || 1;
    proj = projectDirFor(process.cwd());
    if (!proj) { console.error('no transcripts for ' + process.cwd() + ' (expected ~/.claude/projects/' + encodeProjectDir(process.cwd()) + ')'); process.exit(2); }
    ids = latestSessions(proj, n);
  } else { [proj, ...ids] = a; }
  if (!proj || !ids || !ids.length) { console.error('usage: node audit_run.js --here [--last N] [--codex-model M] [--json]\n       node audit_run.js <project-transcript-dir> <session-id> [...]'); process.exit(2); }
  const out = audit(proj, ids, { codexModel, codexModelLight: pluginOption('codex_model_light'), codexModelDesign: pluginOption('codex_model_design'), codexHome: os.homedir() });
  console.log(json ? JSON.stringify(out, null, 2) : render(out));
  process.exit(out.findings.some(x => x.level === 'FAIL') ? 1 : 0);
}

module.exports = { runsOf, isPoll, isHeavy, isShellRead, withBgOutput, parseCodex, codexTokens, codexRollouts, maxOverlap, audit, render, expectedCodexModel, CODEX_CALL, SECRET };
