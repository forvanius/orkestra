#!/usr/bin/env node
// Orkestra dispatcher: what can start now, what is waiting and why, and which parts would collide.
// Reads the board's lane matrix (dependencies, write surfaces) and parts table (states). Changes nothing.
//
//   node next_parts.js <board.md>
//
// Exit: 0 = ok, 1 = a write-surface conflict, a risky part on a cheap model, a bad dependency, a deadlock or an unset working mode,
// 2 = no usable board. Output carries `mode` (auto / checkpoints / ask) so every run reminds the conductor how often to ask.
// A glob counts as its folder, so `src/*.js` and `src/a.py` are reported as overlapping: fix by being exact.
const fs = require('fs');
const { locateTable, cells } = require('./board_check.js');

const MERGED = /^(merged|birleşti|birlesti)$/i, ACTIVE = /^(running|in-review|çalışıyor|calisiyor|incelemede)$/i;
const READY = /^(ready|hazır|hazir)$/i, BLOCKED = /^(blocked|engelli)$/i;
const LOW_RISK = /^(low|düşük|dusuk)\b/i, CHEAP_MODEL = /haiku|light|hafif/i;   // risk comes before cost
const MODES = [['auto', /^(auto|otomatik)\b/i], ['checkpoints', /^(checkpoints?|kontrol noktalar[ıi]|kontrol)\b/i], ['ask', /^(ask|sor)\b/i]];

// How often the user wants to be asked. undefined = the board has no Working mode section (a board from before 0.6.2);
// '' = the section is there but not filled in or not one of auto / checkpoints / ask.
function workingMode(text) {
  const m = text.match(/^##[ \t]*(?:working mode|çalışma tarzı|calisma tarzi)(?![\wÀ-ɏ])[^\n]*\n([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/im);
  if (!m) return undefined;
  const line = m[1].match(/^[ \t]*-?[ \t]*(?:mode|tarz)[ \t]*:[ \t]*`?([^`\n]*)/im);
  const value = line ? line[1].trim() : '';
  const hit = MODES.find(([, re]) => re.test(value));
  return hit ? hit[0] : '';
}

function laneMatrix(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const head = cells(lines[i]).map(h => h.toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const c = { part: col(/^(part|parça|parca)/), parallel: col(/^(parallel|paralel)/), surface: col(/^(write surface|yazma)/), risk: col(/^risk/), model: col(/^model/) };
    if (c.part < 0 || c.parallel < 0 || c.surface < 0) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const r = cells(lines[j]), m = (r[c.parallel] || '').match(/(?:after|sonra)\s*:?\s*(.+)$/i);
      rows.push({ part: r[c.part] || '', after: m ? m[1].split(/[,;\s]+/).filter(Boolean) : [], surface: (r[c.surface] || '').split(/[,;\s]+/).filter(Boolean),
        risk: c.risk >= 0 ? r[c.risk] || '' : null, model: c.model >= 0 ? r[c.model] || '' : '' });
    }
    return rows;
  }
  return null;
}

function normalize(p) {
  let s = p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const star = s.indexOf('*');
  if (star >= 0) s = s.slice(0, Math.max(0, s.lastIndexOf('/', star)));
  return s.replace(/\/+$/, '');
}

function overlap(a, b) {
  for (const x of a.map(normalize)) for (const y of b.map(normalize)) {
    if (x === y || !x || !y || x.startsWith(y + '/') || y.startsWith(x + '/')) return [x || '(root)', y || '(root)'];
  }
  return null;
}

function plan(text) {
  const lane = laneMatrix(text), table = locateTable(text);
  if (!lane || !table) return { code: 2, errors: ['the board needs a lane matrix and a parts table'] };
  const state = Object.fromEntries(table.rows.map(r => [r.part, r.state]));
  const errors = [], conflicts = [], byName = Object.fromEntries(lane.map(l => [l.part, l]));
  const mode = workingMode(text);
  if (mode === '') errors.push('working mode not set: ask the user once (auto / checkpoints / ask) and write it under Working mode');
  for (const l of lane) {
    if (!(l.part in state)) errors.push(`part ${l.part} is in the lane matrix but not in the parts table`);
    if (!l.surface.length) errors.push(`part ${l.part} has no write surface`);
    if (l.risk === '') errors.push(`part ${l.part} has no risk level`);
    if (l.risk && !LOW_RISK.test(l.risk) && CHEAP_MODEL.test(l.model)) conflicts.push(`part ${l.part} is ${l.risk} risk but routed to ${l.model}: cheap models take low-risk parts only`);
    for (const d of l.after) if (!byName[d]) errors.push(`part ${l.part} waits for unknown part ${d}`);
  }
  for (const r of table.rows) if (!byName[r.part]) errors.push(`part ${r.part} is in the parts table but not in the lane matrix`);

  const dependsOn = (a, b, seen = new Set()) => {
    if (seen.has(a)) return false;
    seen.add(a);
    return ((byName[a] || {}).after || []).some(d => d === b || dependsOn(d, b, seen));
  };
  const open = lane.filter(l => !MERGED.test(state[l.part] || ''));
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const [a, b] = [open[i], open[j]];
    const hit = (a.surface.length && b.surface.length) ? overlap(a.surface, b.surface) : null;
    if (hit && !dependsOn(a.part, b.part) && !dependsOn(b.part, a.part)) conflicts.push(`${a.part} and ${b.part} both write ${hit[0] === hit[1] ? hit[0] : hit[0] + ' / ' + hit[1]} and neither waits for the other`);
  }

  const start = [], waiting = [], running = [], blocked = [];
  const taken = open.filter(l => ACTIVE.test(state[l.part] || ''));
  for (const l of taken) running.push(l.part);
  for (const l of open) {
    const s = state[l.part] || '';
    if (BLOCKED.test(s)) { blocked.push(l.part); continue; }
    if (!READY.test(s)) continue;
    const missing = l.after.filter(d => !MERGED.test(state[d] || ''));
    if (missing.length) { waiting.push({ part: l.part, why: `waits for ${missing.join(', ')}` }); continue; }
    const clash = taken.find(t => overlap(l.surface, t.surface));
    if (clash) { waiting.push({ part: l.part, why: `shares files with ${clash.part}` }); continue; }
    start.push(l.part); taken.push(l);
  }
  const stuck = !start.length && !running.length && waiting.length > 0 && !blocked.length;
  if (stuck) errors.push(`nothing can start: ${waiting.map(w => `${w.part} ${w.why}`).join('; ')}`);
  const out = { code: errors.length || conflicts.length ? 1 : 0, start, running, waiting, blocked, conflicts, errors };
  if (mode) out.mode = mode;
  return out;
}

if (require.main === module) {
  if (!process.argv[2] || !fs.existsSync(process.argv[2])) { console.error('usage: node next_parts.js <board.md>'); process.exit(2); }
  const { code, ...out } = plan(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(out));
  process.exit(code);
}

module.exports = { plan, laneMatrix, overlap, workingMode };
