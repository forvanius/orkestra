// node --test tests/check_verdict.test.js
const test = require('node:test');
const assert = require('node:assert');
const { extract, check } = require('../skills/orkestra/check_verdict.js');

const ok = { verdict: 'APPROVE', blockers: [], polish: ['rename x'], goodhart: [], spec: { missing: [], extra: [] } };

test('codex -o output: clean APPROVE stays APPROVE', () => {
  const r = check(extract(JSON.stringify(ok)));
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.final, 'APPROVE');
});

test('APPROVE with goodhart or spec findings is forced to REVISE', () => {
  const v = { ...ok, goodhart: ['threshold 0.95 -> 0.9'], spec: { missing: [], extra: ['new option'] } };
  const r = check(extract(JSON.stringify(v)));
  assert.strictEqual(r.final, 'REVISE');
  assert.deepStrictEqual(r.forced, ['goodhart', 'spec.extra']);
});

test('claude -p --output-format json: structured_output', () => {
  const raw = JSON.stringify({ type: 'result', is_error: false, structured_output: ok, result: 'done' });
  assert.strictEqual(check(extract(raw)).final, 'APPROVE');
});

test('gemini -o json: verdict inside the response text, in a code fence', () => {
  const raw = JSON.stringify({ response: 'Review done.\n```json\n' + JSON.stringify(ok) + '\n```', stats: {} });
  assert.strictEqual(check(extract(raw)).final, 'APPROVE');
});

test('agy --output-format json: structured_output passes; an empty SUCCESS or a timeout is no verdict', () => {
  const run = extra => JSON.stringify({ conversation_id: 'c', num_turns: 1, usage: {}, ...extra });
  assert.strictEqual(check(extract(run({ status: 'SUCCESS', response: JSON.stringify(ok) + '\n', structured_output: ok }))).final, 'APPROVE');
  assert.ok(check(extract(run({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'command', display_name: 'Bash' }] }))).errors.length);
  assert.ok(check(extract(run({ status: 'ERROR', response: '', error: 'print timeout after 5m0s' }))).errors.length);
});

test('plain text ending with JSON', () => {
  assert.strictEqual(check(extract('Looks fine.\n' + JSON.stringify({ ...ok, verdict: 'REVISE', blockers: ['a.js:3 null'] }))).final, 'REVISE');
});

test('missing fields or no JSON is invalid, never an APPROVE', () => {
  assert.ok(check(extract('{"verdict":"APPROVE"}')).errors.length);
  assert.ok(check(extract('LGTM, ship it')).errors.length);
  assert.ok(check(extract('{"verdict":"YES","blockers":[],"polish":[],"goodhart":[],"spec":{"missing":[],"extra":[]}}')).errors.length);
});

test('a "tests not re-run" note is the verifier\'s run, not an open question; real ones stay open', () => {
  const { splitCannotVerify, check } = require('../skills/orkestra/check_verdict.js');
  const runNotes = [   // what reviewers actually wrote in the pilots
    'node --test tests/*.test.js result not re-run; the report says 0 failed',
    'Tests not re-run by the reviewer',
    'I did not run the test suite (read-only review)',
    'acceptance command was not executed here',
    "I haven't run the tests.",
    'I haven’t run the tests',
    'npm test was not run',
    '`node tests/run.js` not re-run',
  ];
  const real = [   // a test word and "not run" may appear, but with another subject the item stays open
    'the save format lives in untouched code: check save.js keeps reading old saves',
    'whether part B calls the renamed helper (spans parts)',
    'the migration runs against production data only in the deploy step',
    'I could not verify that the untouched save code preserves legacy saves when the migration is run. No test covers that path.',
    'I did not run the tests. I also could not verify that Part B still calls the renamed helper.',
    'I could not verify whether the production gateway accepts the signature when the smoke test is run.',
    'tests for the legacy importer were not run because the importer is untouched; check it reads v1 files',
    'I did not run npm test. I still cannot verify whether the production gateway accepts the signature.',
    'Tests not re-run (read-only review, and I could not verify whether Part B preserves legacy saves).',
    'npm test whether legacy saves load was not run',                                    // a question folded into the command
    'tests not re-run; the report says legacy saves are untested',                        // a gap hidden in the report clause
  ];
  const t0 = Date.now();   // bounded: a hostile long item answers at once
  splitCannotVerify(['npm test' + ' '.repeat(150) + 'x', 'npm ' + 'a '.repeat(90) + 'not run']);
  assert.ok(Date.now() - t0 < 200);
  const r = splitCannotVerify([...runNotes, ...real]);
  assert.deepStrictEqual(r.verifierRuns, runNotes);
  assert.deepStrictEqual(r.open, real);
  const v = { verdict: 'APPROVE', blockers: [], polish: [], goodhart: [], spec: { missing: [], extra: [] }, cannot_verify: [runNotes[0]] };
  assert.deepStrictEqual([check(v).final, check(v).cannotVerify, check(v).verifierRuns], ['APPROVE', [], [runNotes[0]]]);
});
