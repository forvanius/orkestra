#!/usr/bin/env node
// Orkestra handoff guard (PostToolUse hook). In a session that loaded the orkestra skill, once the
// conductor's context has grown past LIMIT it says: finish the user's current request, then hand off.
// Past HARD it says stop now. It repeats every further STEP.
// This is a cost limit, not the size of the context window: sessions have run far past it without
// compaction. Growth, not the total: with many plugins a fresh session already starts at ~80-100 K,
// and a handoff only wins back what was added after that. The first calls don't count either: the
// tool list, MCP instructions and the skill itself arrive there (measured: +7-14 K before any work).
//
// Reads only the transcript bytes added since its last call (state per session in the plugin's
// data folder), stays silent in sessions that never loaded orkestra, and never fails the tool call.
const fs = require('fs'), path = require('path'), os = require('os');

const LIMIT = 250_000, HARD = 400_000, STEP = 50_000, BOOT_CALLS = 3;
const SKILL = /^orkestra(?::orkestra)?$/;
const SLASH = /<command-name>\/(?:orkestra:)?orkestra<\/command-name>/;

// Only a real load counts: file names like onboard.md, or a tool reading this plugin's source, don't.
function loadsOrkestra(entry) {
  const content = entry.message && entry.message.content;
  if (entry.type === 'assistant') return Array.isArray(content) && content.some(b => b.type === 'tool_use' && b.name === 'Skill' && SKILL.test(String((b.input || {}).skill)));
  if (entry.type !== 'user') return false;
  if (typeof content === 'string') return SLASH.test(content);
  return Array.isArray(content) && content.some(b => b.type === 'text' && SLASH.test(b.text || ''));
}

function message(st, grown) {
  const where = `Orkestra handoff rule: the conductor's context is ~${Math.round(st.ctx / 1000)} K, ~${Math.round(grown / 1000)} K above where this session started`;
  const handoff = 'tell the user: "open a new session and say: /orkestra:orkestra continue from <board path>"';
  if (grown >= HARD) return `${where} (hard limit ${HARD / 1000} K). Start no new part and write no new brief. Let running parts finish, bring the board up to date, get board_check.js --handoff to pass, then ${handoff}. Every further call re-reads this whole context.`;
  return `${where} (limit ${LIMIT / 1000} K). Finish the request the user already gave you and take on no new one. When it is done, bring the board up to date, get board_check.js --handoff to pass, then ${handoff}.`;
}

function guard(input, dataDir) {
  const { session_id: sid, transcript_path: tp } = input || {};
  if (!sid || !tp || !fs.existsSync(tp)) return null;
  const stateFile = path.join(dataDir, 'handoff', sid.replace(/[^\w-]/g, '') + '.json');
  let st = { offset: 0, orkestra: false, warnedAt: 0, ctx: 0, base: 0 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch {}
  if (st.calls == null) st.calls = st.base ? BOOT_CALLS : 0;          // state written by an older version

  const size = fs.statSync(tp).size;
  if (size < st.offset) st = { ...st, offset: 0 };                 // transcript rewritten
  if (size > st.offset) {
    const fd = fs.openSync(tp, 'r'), buf = Buffer.alloc(size - st.offset);
    fs.readSync(fd, buf, 0, buf.length, st.offset); fs.closeSync(fd);
    const text = buf.toString('utf8'), end = text.lastIndexOf('\n') + 1;   // whole lines only
    for (const line of text.slice(0, end).split('\n')) {
      if (!line || (!line.includes('"usage"') && !line.includes('orkestra'))) continue;
      try {
        const j = JSON.parse(line);
        if (!st.orkestra && loadsOrkestra(j)) st.orkestra = true;
        const m = j.type === 'assistant' && j.message, u = m && m.usage;
        if (!u) continue;
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (!ctx) continue;                                             // synthetic messages carry zero usage
        st.ctx = ctx;
        if (m.id && m.id === st.lastId) continue;                       // one API call, several transcript lines
        st.lastId = m.id; st.calls++;
        if (st.calls <= BOOT_CALLS) st.base = ctx;
        else if (ctx < st.base) { st.base = ctx; st.warnedAt = 0; }     // after a compaction
      } catch {}
    }
    st.offset += Buffer.byteLength(text.slice(0, end), 'utf8');
  }

  let msg = null;
  const grown = st.ctx - st.base;
  if (st.orkestra && grown > LIMIT && (!st.warnedAt || st.ctx - st.warnedAt >= STEP)) {
    st.warnedAt = st.ctx;
    msg = message(st, grown);
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(st));
  return msg;
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'orkestra-plugin-data');
      const msg = guard(JSON.parse(raw), dataDir);
      if (msg) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
    } catch {}
    process.exit(0);
  });
}

module.exports = { guard, LIMIT, HARD, STEP, BOOT_CALLS };
