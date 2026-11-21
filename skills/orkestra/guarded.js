#!/usr/bin/env node
// Orkestra run guard: the logistics a brief can only ask for, enforced.
//
//   node guarded.js quota                                   Codex quota and Claude estimate; exit 4 if near either limit
//   node guarded.js codex [--minutes 25] [--ignore-quota] -- codex exec ... - < brief.txt
//   node guarded.js heavy [--minutes 25] [--slots 3] [--wait-minutes 30] -- python tools/smoke.py
//
// codex: refuses to start when the plan's quota is nearly gone, stops the run at the time limit.
// heavy: waits for one of the machine's slots (shared by every session), runs below normal priority,
//        stops the run at the time limit.
// stdin and stdout pass straight through. Exit: the command's own code, 124 = time limit,
// 4 = quota, 6 = no free slot in time, 2 = bad usage.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');
const { latestSessions } = require('./usage_sum.js');

const WINDOW_LIMIT = 85, WEEK_LIMIT = 90;      // % used; a run started above these may die half-way
const CLAUDE_WINDOW_MS = 5 * 3600_000, CLAUDE_LIMIT = 90, CLAUDE_WARNING = 80;
const WIN = process.platform === 'win32';

function newestRollouts(home, max = 20) {
  const found = [];
  const walk = (dir, depth) => {
    let names; try { names = fs.readdirSync(dir).sort().reverse(); } catch { return; }
    for (const n of names) {
      if (found.length >= max) return;
      const f = path.join(dir, n);
      if (depth < 3) walk(f, depth + 1);
      else if (n.endsWith('.jsonl')) found.push({ f, m: fs.statSync(f).mtimeMs });
    }
  };
  walk(path.join(home, '.codex', 'sessions'), 0);
  return found.sort((a, b) => b.m - a.m).map(x => x.f);
}

// What Codex last recorded about the plan's limits. A window that has already reset counts as empty.
function latestQuota(home = os.homedir(), now = Date.now()) {
  const pct = w => !w ? null : (w.resets_at && w.resets_at * 1000 < now) ? 0 : w.used_percent;
  for (const f of newestRollouts(home)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      try {
        const p = JSON.parse(lines[i]).payload || {}, r = p.rate_limits;
        if (p.type !== 'token_count' || !r || !r.primary) continue;
        const t = Date.parse(JSON.parse(lines[i]).timestamp), at = isNaN(t) ? fs.statSync(f).mtimeMs : t;
        return { windowPct: pct(r.primary), weeklyPct: pct(r.secondary), ageHours: Math.max(0, Math.round((now - at) / 36e5 * 10) / 10) };
      } catch {}
    }
  }
  return null;
}

function quotaBlocks(q) {
  const why = [];
  if (q && q.windowPct >= WINDOW_LIMIT) why.push(`5 h window ${q.windowPct}% used (limit ${WINDOW_LIMIT}%)`);
  if (q && q.weeklyPct >= WEEK_LIMIT) why.push(`week ${q.weeklyPct}% used (limit ${WEEK_LIMIT}%)`);
  // The figure is only as fresh as Codex's last run: a limit renewed early (credits, plan change) shows up only after the next run.
  if (why.length && q.ageHours != null) why.push(`recorded ${q.ageHours} h ago by Codex's last run; if the user says the limit was renewed since, rerun once with --ignore-quota (Codex's own error is then the gate)`);
  return why;
}

function claudeLimit(home) {
  let value = process.env.ORKESTRA_CLAUDE_WINDOW_READS_M?.trim() ||
    process.env.CLAUDE_PLUGIN_OPTION_CLAUDE_WINDOW_READS_M?.trim();
  if (!value) {
    const settings = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
    try {
      const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
      value = config?.pluginConfigs?.['orkestra@orkestra']?.options?.claude_window_reads_m;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('could not read Claude plugin settings');
    }
  }
  const limit = Number(value);
  return (typeof value === 'number' || typeof value === 'string') && Number.isFinite(limit) && limit > 0 ? limit : null;
}

function claudeQuota(home = os.homedir(), now = Date.now()) {
  const root = process.env.ORKESTRA_CLAUDE_PROJECTS || path.join(home, '.claude', 'projects');
  const cutoff = now - CLAUDE_WINDOW_MS, seen = new Set();
  let tokens = 0, skippedFiles = 0;

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }

    const transcripts = new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => entry.name));
    for (const id of transcripts.size ? latestSessions(dir, Infinity) : []) {
      const name = `${id}.jsonl`;
      if (!transcripts.has(name)) continue;
      const file = path.join(dir, name);
      let messages;
      try {
        if (fs.statSync(file).mtimeMs < cutoff) continue;
        // Validate the whole file before adding any usage or recording message IDs.
        messages = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
      } catch (error) {
        if (!(error instanceof SyntaxError) && !error.code) throw error;
        skippedFiles++;
        continue;
      }
      for (const entry of messages) {
        if (entry?.type !== 'assistant' || !entry.message?.usage) continue;
        const time = Date.parse(entry.timestamp);
        if (!Number.isFinite(time) || time < cutoff || time > now) continue;
        const { id, usage } = entry.message;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const { input_tokens, cache_read_input_tokens } = usage;
        tokens += (Number.isFinite(input_tokens) ? input_tokens : 0) +
          (Number.isFinite(cache_read_input_tokens) ? cache_read_input_tokens : 0);
      }
    }
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(dir, entry.name));
  }

  walk(root);
  const windowReadsM = tokens / 1e6, limitM = claudeLimit(home);
  return { windowReadsM, limitM, pct: limitM === null ? null : windowReadsM * 100 / limitM, estimate: true, skippedFiles };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One file per slot, created atomically; a slot whose owner has died is taken over.
async function acquireSlot(dir, slots, waitMinutes) {
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const f = path.join(dir, `slot-${i}`);
      try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); return f; } catch {}
      try { if (!alive(parseInt(fs.readFileSync(f, 'utf8'), 10))) fs.unlinkSync(f); } catch {}
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(2000, Math.max(50, deadline - Date.now())));
  }
}

const quote = a => /^[\w@%+=:,./\\-]+$/.test(a) ? a : WIN ? `"${a.replace(/"/g, '\\"')}"` : `'${a.replace(/'/g, `'\\''`)}'`;

function killTree(pid) {
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-pid, 'SIGKILL'); } catch {} }
}

function run(argv, { minutes, low }) {
  return new Promise(resolve => {
    const child = spawn(argv.map(quote).join(' '), { shell: true, stdio: 'inherit', detached: !WIN });
    if (low) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
    let timedOut = false;
    const stop = () => killTree(child.pid);
    const timer = setTimeout(() => { timedOut = true; stop(); }, minutes * 60_000);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    child.on('close', code => { clearTimeout(timer); resolve({ code: code == null ? 1 : code, timedOut }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, timedOut }); });
  });
}

function parse(args) {
  const i = args.indexOf('--'), flags = i >= 0 ? args.slice(0, i) : args, cmd = i >= 0 ? args.slice(i + 1) : [];
  const num = (k, d) => { const x = flags.indexOf(k); return x >= 0 ? parseFloat(flags[x + 1]) : d; };
  return { minutes: num('--minutes', 25), slots: num('--slots', 3), wait: num('--wait-minutes', 30), ignoreQuota: flags.includes('--ignore-quota'), cmd };
}

const say = o => console.log(JSON.stringify(o));

async function main(argv) {
  const mode = argv[0], o = parse(argv.slice(1));
  if (mode === 'quota') {
    const q = latestQuota(), claude = claudeQuota(), blocked = quotaBlocks(q);
    if (claude.pct >= CLAUDE_LIMIT) blocked.push('claude');
    say({ quota: q, claude, blocked });
    return blocked.length ? 4 : 0;
  }
  if (!['codex', 'heavy'].includes(mode) || !o.cmd.length || !(o.minutes > 0)) {
    console.error('usage: node guarded.js quota\n       node guarded.js codex [--minutes N] [--ignore-quota] -- <command>\n       node guarded.js heavy [--minutes N] [--slots N] [--wait-minutes N] -- <command>');
    return 2;
  }
  const claude = claudeQuota();
  if (mode === 'codex' && claude.pct >= CLAUDE_WARNING) {
    console.error(`warning: Claude's 5 h quota is estimated at ${claude.pct.toFixed(1)}% used`);
  }
  if (mode === 'codex' && !o.ignoreQuota) {
    const q = latestQuota(), blocked = quotaBlocks(q);
    if (blocked.length) { say({ guarded: 'quota', started: false, quota: q, claude, blocked }); return 4; }
  }
  if (mode === 'heavy' && claude.pct >= CLAUDE_LIMIT) {
    say({ guarded: 'quota', started: false, claude, blocked: ['claude'] });
    return 4;
  }
  let slot = null;
  if (mode === 'heavy') {
    slot = await acquireSlot(process.env.ORKESTRA_SLOT_DIR || path.join(os.tmpdir(), 'orkestra-slots'), o.slots, o.wait);
    if (!slot) { say({ guarded: 'no-slot', started: false, slots: o.slots, waited_minutes: o.wait }); return 6; }
    process.on('exit', () => { try { fs.unlinkSync(slot); } catch {} });
  }
  const r = await run(o.cmd, { minutes: o.minutes, low: mode === 'heavy' });
  if (r.timedOut) { say({ guarded: 'timeout', minutes: o.minutes }); return 124; }
  return r.code;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code), error => {
  console.error(`guarded: ${error.code || error.message}`);
  process.exit(1);
});

module.exports = { latestQuota, quotaBlocks, acquireSlot, WINDOW_LIMIT, WEEK_LIMIT };
