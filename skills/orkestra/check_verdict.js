#!/usr/bin/env node
// Orkestra verdict gate: makes any CLI's review output machine-checkable.
//
//   node check_verdict.js <file>        (or pipe the output on stdin)
//
// Accepts Codex `-o result.json`, `claude -p --output-format json` (structured_output or result),
// `agy --output-format json` (structured_output), `gemini -o json` (response), or plain text that ends with a JSON object. Validates it against
// review-schema.json's rules and prints the normalized verdict.
// Exit: 0 = APPROVE, 1 = REVISE (stated or forced by goodhart/spec), 2 = no valid verdict found.
const fs = require('fs');

function lastJsonObject(text) {
  // Scan from the end for a balanced {...} that parses; agents often wrap JSON in prose or fences.
  for (let end = text.lastIndexOf('}'); end > 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{' && --depth === 0) {
        try { return JSON.parse(text.slice(i, end + 1)); } catch { break; }
      }
    }
  }
  return null;
}

function extract(raw) {
  let j = null;
  try { j = JSON.parse(raw); } catch { return lastJsonObject(raw); }
  if (j && typeof j === 'object' && 'verdict' in j) return j;
  for (const k of ['structured_output', 'result', 'response']) {   // claude -p, gemini -o json
    const v = j && j[k];
    if (v && typeof v === 'object' && 'verdict' in v) return v;
    if (typeof v === 'string') { const inner = lastJsonObject(v); if (inner) return inner; }
  }
  return null;
}

const strings = a => Array.isArray(a) && a.every(x => typeof x === 'string');

// Running the tests is the verifier's job, and reviewers keep listing "tests not re-run" under
// cannot_verify anyway (told not to in two places). Such a note asks for a run the verifier makes in
// any case, so it doesn't hold a close; it is passed on as verifier_runs instead of dropped.
// Fail-safe: only an item that is NOTHING BUT that note matches (one clause, anchored at both ends).
// Any other subject in it — "could not verify", "whether", a second sentence — keeps it a real
// cannot_verify item that holds the close.
// A command is at most 8 space-free tokens, none ending a sentence: bounded, so no runaway backtracking.
const TOKEN = String.raw`[^\s;,()]*[^\s;,().!?]`;
const SUBJECT = String.raw`(?:the\s+)?(?:` + '`[^`]{1,200}`' + String.raw`|(?:node|npm|npx|pnpm|yarn|pytest|python|go|cargo|dotnet|mvn|gradle|make)(?:\s+${TOKEN}){0,8}|tests?|test\s+suite|suite|acceptance(?:\s+(?:command|checks?))?|checks?|smoke\s+tests?|unit\s+tests?)(?:\s+results?)?`;
const TAIL = String.raw`(?:\s+(?:by\s+(?:me|the\s+reviewer)|here|in\s+this\s+review|myself))?(?:\s*\((?:read-only|no\s+shell)(?:\s+review)?\))?(?:\s*[;,]\s*the\s+(?:writer'?s\s+)?report\s+(?:says|lists|shows)\s+(?:all\s+(?:pass|passed|green)|green|\d+\s+(?:passed|pass|failed|fail)(?:\s*[,/]\s*\d+\s+(?:passed|pass|failed|fail))?))?`;   // only a count: free text there could carry a real gap
const PASSIVE = new RegExp(String.raw`^${SUBJECT}\s+(?:(?:was|were|is|are)\s+)?(?:not|never)\s+(?:re-?run|rerun|run|executed)${TAIL}$`, 'i');
const FIRST = new RegExp(String.raw`^i\s+(?:did\s+not|didn'?t|have\s+not|haven'?t|could\s+not|couldn'?t|was\s+unable\s+to)\s+(?:re-?run|rerun|run|execute)\s+${SUBJECT}${TAIL}$`, 'i');
// Second guard, independent of the patterns: a question word or a second sentence keeps it open.
const OTHER_SUBJECT = /\b(verify|verified|whether|confirm|check\s+that|unclear|unknown|could\s+not\s+tell|cannot\s+tell|if\s+part|also|still)\b|[.!?]\s+\S/i;
const isRunNote = s => {
  const t = String(s).trim().replace(/[.!]+$/, '').replace(/[’]/g, "'");
  if (t.length > 200 || OTHER_SUBJECT.test(t)) return false;
  return PASSIVE.test(t) || FIRST.test(t);
};
function splitCannotVerify(items) {
  const all = Array.isArray(items) ? items : [];
  return { open: all.filter(s => !isRunNote(s)), verifierRuns: all.filter(isRunNote) };
}

function check(v) {
  const errors = [];
  if (!v || typeof v !== 'object') return { errors: ['no JSON verdict found'] };
  if (!['APPROVE', 'REVISE'].includes(v.verdict)) errors.push('verdict must be APPROVE or REVISE');
  for (const k of ['blockers', 'polish', 'goodhart']) if (!strings(v[k])) errors.push(`${k} must be an array of strings`);
  if (!v.spec || !strings(v.spec.missing) || !strings(v.spec.extra)) errors.push('spec.missing and spec.extra must be arrays of strings');
  if ('cannot_verify' in v && !strings(v.cannot_verify)) errors.push('cannot_verify must be an array of strings');
  if (errors.length) return { errors };
  const reasons = [];
  if (v.blockers.length) reasons.push('blockers');
  if (v.goodhart.length) reasons.push('goodhart');
  if (v.spec.missing.length) reasons.push('spec.missing');
  if (v.spec.extra.length) reasons.push('spec.extra');
  const final = v.verdict === 'APPROVE' && reasons.length ? 'REVISE' : v.verdict;
  const { open, verifierRuns } = splitCannotVerify(v.cannot_verify);
  return { errors, final, forced: final !== v.verdict ? reasons : [], cannotVerify: open, verifierRuns };
}

if (require.main === module) {
  const raw = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fs.readFileSync(0, 'utf8');
  const v = extract(raw);
  const r = check(v);
  if (r.errors.length) { console.log(JSON.stringify({ valid: false, errors: r.errors })); process.exit(2); }
  console.log(JSON.stringify({ valid: true, verdict: r.final, stated: v.verdict, forced_by: r.forced,
    blockers: v.blockers, goodhart: v.goodhart, spec: v.spec, polish: v.polish, cannot_verify: r.cannotVerify, verifier_runs: r.verifierRuns }));
  process.exit(r.final === 'APPROVE' ? 0 : 1);
}

module.exports = { extract, check, splitCannotVerify };
