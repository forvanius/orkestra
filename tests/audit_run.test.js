// node --test tests/audit_run.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { parseCodex, codexTokens, codexRollouts, isShellRead, maxOverlap, audit, render, CODEX_CALL, SECRET } = require('../skills/orkestra/audit_run.js');

test('only real codex exec invocations count (false positives found on real transcripts)', () => {
  assert.ok(CODEX_CALL.test('codex exec -m x -s read-only - < r.txt'));
  assert.ok(CODEX_CALL.test('cd wt && codex exec -m x -s workspace-write - < b.txt'));
  assert.ok(CODEX_CALL.test('$o = codex exec -m x - < b.txt'));
  assert.ok(!CODEX_CALL.test('codex exec --help 2>&1 | Select-String output-schema'));
  assert.ok(!CODEX_CALL.test('Get-Command codex; grep "codex exec" docs/instruments.md'));
  assert.ok(!CODEX_CALL.test('echo "run codex exec later"'));
});

test('secret pattern ignores code that only names SECRET', () => {
  assert.ok(!SECRET.test('const SECRET = /(sk-[A-Za-z0-9_-]{20,}|AIza/'));
  assert.ok(!SECRET.test('API_KEY = os.getenv("DEEPL_API_KEY")'));
  assert.ok(SECRET.test('DEEPL_API_KEY=0123456789abcdef0123'));
});

let n = 0;
const T = min => new Date(Date.UTC(2026, 9, 28, 10, min)).toISOString();
const asst = (min, ctx, effort = 'medium', model = 'claude-opus-x') => ({ type: 'assistant', timestamp: T(min), effort,
  message: { id: 'm' + (++n), model, usage: { input_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, output_tokens: 5 } } });
const use = (min, id, name, input) => ({ type: 'assistant', timestamp: T(min), message: { id: 'u' + id, content: [{ type: 'tool_use', id, name, input }] } });
const res = (min, id, text) => ({ type: 'user', timestamp: T(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const notify = (min, id) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(min), content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>` });
const sub = (from, to, model) => [asst(from, 1000, 'low', model), asst(to, 1000, 'low', model)];

function write(dir, file, entries) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), entries.map(e => JSON.stringify(e)).join('\n')); }

function fixture(main, subs = []) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-audit-'));
  write(proj, 's1.jsonl', main);
  subs.forEach(([desc, type, entries], i) => {
    const d = path.join(proj, 's1', 'subagents');
    write(d, `a${i}.jsonl`, entries);
    fs.writeFileSync(path.join(d, `a${i}.meta.json`), JSON.stringify({ description: desc, agentType: type }));
  });
  return proj;
}

const W = '-c model_reasoning_effort=medium -s workspace-write - < brief.txt';
const R = '-c model_reasoning_effort=medium -s read-only --output-schema review-schema.json -o result.json - < review.txt';

test('parseCodex reads model, effort, sandbox and role', () => {
  assert.deepStrictEqual(parseCodex(`codex exec -m gpt-x ${W}`), { model: 'gpt-x', effort: 'medium', sandbox: 'workspace-write', schema: false, role: 'writer' });
  assert.strictEqual(parseCodex(`codex exec -m gpt-x ${R}`).role, 'reviewer');
  assert.strictEqual(parseCodex('codex exec -m gpt-x -s read-only - < q.txt').role, 'diagnosis');
  assert.strictEqual(parseCodex('codex exec -s workspace-write - < b').model, null);
});

test('codexTokens handles thousands separators', () => {
  assert.strictEqual(codexTokens('codex\n...\ntokens used\n20.658\n{}'), 20658);
  assert.strictEqual(codexTokens('tokens used 1,234'), 1234);
  assert.strictEqual(codexTokens('no usage here'), null);
});

test('maxOverlap counts concurrent intervals', () => {
  assert.strictEqual(maxOverlap([[T(0), T(10)], [T(5), T(15)], [T(12), T(20)]]), 2);
  assert.strictEqual(maxOverlap([[T(0), T(5)], [T(5), T(9)]]), 1);   // touching, not overlapping
});

test('a clean run has no FAIL or WARN', () => {
  const proj = fixture([
    asst(0, 50_000),
    use(1, 'b1', 'Write', { file_path: 'C:/s/job/board.md', content: '## Design note\n- Goal: x' }),
    use(2, 'w1', 'Bash', { command: `node guarded.js codex --minutes 25 -- codex exec -m gpt-x ${W}` }), res(12, 'w1', 'done\ntokens used\n148.000'),
    use(13, 'v1', 'Agent', { description: 'verify part A', subagent_type: 'orkestra:verifier' }),
    use(20, 'r1', 'Bash', { command: `node "C:/p/guarded.js" codex --minutes 25 -- codex exec -m gpt-x ${R}` }), res(25, 'r1', 'tokens used\n108.000'),
    use(26, 'g1', 'Bash', { command: 'node check_verdict.js result.json' }), res(26, 'g1', '{"valid":true,"verdict":"APPROVE"}'),
    use(27, 'k1', 'Bash', { command: 'node board_check.js C:/s/job/board.md --merge A' }), res(27, 'k1', '{"ok":true}'),
    asst(30, 60_000),
  ], [['verify part A', 'orkestra:verifier', sub(14, 18, 'claude-haiku-x')]]);
  const { facts, findings } = audit(proj, ['s1'], { codexModel: 'gpt-x' });
  assert.deepStrictEqual(findings, []);
  assert.strictEqual(facts.reviews, 1);
  assert.strictEqual(facts.gates, 1);
  assert.strictEqual(facts.codexTokens, 256000);
  assert.strictEqual(facts.codex[0].minutes, 10);
  assert.strictEqual(facts.designNote, true);
});

test('continued sessions are not double counted (found on the first real run)', () => {
  const proj = fixture([]);
  const shared = [asst(0, 100_000), use(1, 'w1', 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(5, 'w1', 'ok')];
  write(proj, 'a.jsonl', shared);
  write(proj, 'b.jsonl', [...shared, asst(10, 50_000), use(11, 'w2', 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(15, 'w2', 'ok')]);
  const { facts } = audit(proj, ['a', 'b'], { codexModel: 'gpt-x' });
  assert.strictEqual(facts.codex.length, 2);
  assert.strictEqual(facts.conductor.readsM, 0.15);
  const { collect } = require('../skills/orkestra/usage_sum.js');
  const rows = collect(proj, ['a', 'b']);
  assert.strictEqual(rows.reduce((s, r) => s + r.r.n, 0), 2);
});

test('polling: reads before the completion notice and wait loops count, reading the result after does not', () => {
  const bg = use(0, 'bg1', 'Bash', { command: `codex exec -m gpt-x ${W} > "C:/t/scratchpad/codex_tur1.log" 2>&1`, run_in_background: true });
  const reads = Array.from({ length: 6 }, (_, i) => use(i + 1, 'p' + i, 'Bash', { command: 'tail -c 700 "C:/t/scratchpad/codex_tur1.log"' }));
  const after = use(30, 'a1', 'Bash', { command: 'tail -c 700 "C:/t/scratchpad/codex_tur1.log"' });
  const loop = use(31, 'l1', 'PowerShell', { command: "$f='C:\\t\\tasks\\bx.output'; for($i=0;$i -lt 30;$i++){ if(Select-String -Path $f -Pattern 'EXIT=' -Quiet){break}; Start-Sleep 20 }" });
  const { facts, findings } = audit(fixture([bg, res(0, 'bg1', 'Command running in background'), ...reads, notify(20, 'bg1'), after, loop]), ['s1'], { codexModel: 'gpt-x' });
  assert.strictEqual(facts.polls, 7);
  assert.ok(findings.some(f => f.rule === 'polling'));
});

test('smoke runs at normal priority are flagged; briefs that mention smoke are not', () => {
  const runs = [
    use(1, 's1', 'Bash', { command: 'cd wt && SMOKE_SERIAL=1 SMOKE_ONLY=a python tools/smoke.py > out.txt' }),
    use(2, 's2', 'PowerShell', { command: "$env:SMOKE_ONLY='a'; Start-Process python -ArgumentList 'tools/smoke.py' -Priority BelowNormal" }),
    use(3, 's3', 'PowerShell', { command: "$env:SMOKE_SERIAL='1'; $env:SMOKE_ONLY='b'; python tools/smoke.py *> out.txt" }),
    use(4, 'b1', 'Bash', { command: "cat > brief.txt <<'EOF'\nACCEPTANCE: python tools/smoke.py -> 0 FAIL\nEOF" }),
    use(5, 'b2', 'Bash', { command: 'python --version; python -c "import playwright"' }),
  ];
  const { facts, findings } = audit(fixture(runs), ['s1'], {});
  assert.strictEqual(facts.heavyRuns, 3);
  assert.strictEqual(facts.heavyNormal, 2);
  assert.ok(findings.some(f => f.rule === 'cpu' && /2 of 3/.test(f.msg)));
});

test('a REVISE from a gate that ran in the background is counted (found in the second real run)', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ork-bg-')), 'bq1.output');
  fs.writeFileSync(out, '{"valid":true,"verdict":"REVISE","forced_by":[]}\ngate=1');
  const proj = fixture([
    use(1, 'g1', 'Bash', { command: `codex exec -m gpt-x ${R} && node check_verdict.js result.json`, run_in_background: true }),
    res(1, 'g1', `Command running in background with ID: bq1. Output is being written to: ${out}`), notify(9, 'g1'),
  ]);
  assert.strictEqual(audit(proj, ['s1'], { codexModel: 'gpt-x' }).facts.revisesGated, 1);
});

test('a bad run is caught rule by rule', () => {
  const proj = fixture([
    asst(0, 50_000, 'high'), asst(0, 50_000, 'high'), asst(0, 50_000, 'high'), asst(0, 350_000, 'high'),
    use(1, 'w1', 'Bash', { command: 'codex exec -s workspace-write - < brief.txt' }), res(2, 'w1', 'ok'),
    use(3, 'r1', 'Bash', { command: 'codex exec -m ${user_config.codex_model} ' + R }), res(4, 'r1', 'ok'),
    use(5, 'r2', 'Bash', { command: 'codex exec -m other-model -c model_reasoning_effort=high -s read-only - < q', run_in_background: true }),
    notify(40, 'r2'),
    use(6, 'i1', 'Read', { file_path: 'C:/cap/frame.png' }),
    use(7, 'x1', 'Bash', { command: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx && git reset --hard HEAD' }),
  ], [
    ['worker A', 'orkestra:worker', sub(10, 30, 'claude-sonnet-x')],
    ['worker B', 'orkestra:worker', sub(11, 30, 'claude-opus-x')],
    ['verify A', 'orkestra:verifier', sub(12, 30, 'claude-sonnet-x')],
    ['verify B', 'orkestra:verifier', sub(13, 30, 'claude-haiku-x')],
  ]);
  const { facts, findings } = audit(proj, ['s1'], { codexModel: 'gpt-x' });
  const has = (level, rule, re) => findings.some(f => f.level === level && f.rule === rule && (!re || re.test(f.msg)));
  assert.ok(has('FAIL', 'codex-model', /without -m/));
  assert.ok(has('FAIL', 'codex-model', /placeholder not substituted/));
  assert.ok(has('WARN', 'codex-model', /expected "gpt-x"/));
  assert.ok(has('WARN', 'codex-effort', /without explicit effort/));
  assert.ok(has('FAIL', 'subagent-model', /strongest model/));
  assert.ok(has('WARN', 'subagent-model', /expected Haiku/));
  assert.ok(has('FAIL', 'parallel', /4 Claude subagents/));
  assert.ok(has('WARN', 'conductor-context'));
  assert.ok(has('WARN', 'conductor-reads'));
  assert.ok(has('WARN', 'gate', /read by eye/));
  assert.ok(has('WARN', 'board'));
  assert.ok(has('WARN', 'gate', /board_check/));
  assert.ok(has('FAIL', 'secret'));
  assert.ok(has('WARN', 'git', /reset --hard/));
  assert.strictEqual(facts.codex.find(c => c.model === 'other-model').minutes, 35);   // background run timed by its notification
  assert.ok(!findings.some(f => f.rule === 'secret' && /abcde|sk-abc/.test(f.msg)), 'secret value must be masked');

  // a key that starts the match must not leak either
  const p2 = fixture([use(1, 'k1', 'Bash', { command: 'curl -H "Authorization: Bearer sk-zyxwvutsrqponmlkjihgfedcba" x' })]);
  const f2 = audit(p2, ['s1'], {}).findings.find(f => f.rule === 'secret');
  assert.ok(f2 && !/zyxwv/.test(f2.msg), f2 && f2.msg);
});

test('context is judged by growth like the hook: a 300 K session that started at 100 K is fine', () => {
  const quiet = audit(fixture([asst(0, 100_000), asst(1, 100_000), asst(2, 100_000), asst(3, 300_000)]), ['s1'], {});
  assert.ok(!quiet.findings.some(f => f.rule === 'conductor-context'));
  assert.strictEqual(quiet.facts.conductor.maxGrowthK, 200);
});

test('a model chosen on the Agent call is not a routing error; design agents are not orkestra\'s to route', () => {
  const lane = use(1, 'a1', 'Agent', { description: 'docs part', subagent_type: 'orkestra:worker', model: 'haiku' });
  const { findings } = audit(fixture([lane], [
    ['docs part', 'orkestra:worker', sub(2, 5, 'claude-haiku-x')],
    ['finish review', 'impeccable-finish-reviewer', sub(6, 9, 'claude-opus-x')],
  ]), ['s1'], {});
  assert.deepStrictEqual(findings.filter(f => f.rule === 'subagent-model'), []);
});

test('a light Codex model is accepted; a Claude review counts as a review and clears the routing warning', () => {
  const w = i => [use(i, 'w' + i, 'Bash', { command: `codex exec -m gpt-light ${W}` }), res(i + 1, 'w' + i, 'ok')];
  const cr = i => use(i, 'c' + i, 'Agent', { description: 'review ' + i, subagent_type: 'orkestra:reviewer' });
  const { facts, findings } = audit(fixture([...w(1), ...w(3), cr(5), cr(6)]), ['s1'], { codexModel: 'gpt-x', codexModelLight: 'gpt-light' });
  assert.strictEqual(facts.reviews, 2);
  assert.strictEqual(facts.claudeReviews, 2);
  assert.ok(!findings.some(f => f.rule === 'codex-model' || f.rule === 'review' || f.rule === 'routing'));
});

test('a design Codex model is accepted; an unknown model still warns', () => {
  const w = (i, m) => [use(i, 'w' + i, 'Bash', { command: `codex exec -m ${m} ${W}` }), res(i + 1, 'w' + i, 'ok')];
  const { findings } = audit(fixture([...w(1, 'gpt-design'), ...w(3, 'gpt-other')]), ['s1'], { codexModel: 'gpt-x', codexModelDesign: 'gpt-design' });
  const warns = findings.filter(f => f.rule === 'codex-model');
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0].msg, /gpt-other/);
});

test('all-Codex routing and same-vendor review are flagged', () => {
  const w = i => [use(i, 'w' + i, 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(i + 1, 'w' + i, 'ok')];
  const r = [use(20, 'r1', 'Bash', { command: `codex exec -m gpt-x ${R}` }), res(21, 'r1', 'ok')];
  const { findings } = audit(fixture([...w(1), ...w(3), ...w(5), ...w(7), ...r]), ['s1'], { codexModel: 'gpt-x' });
  assert.ok(findings.some(f => f.rule === 'routing' && /came from Codex/.test(f.msg)));
  assert.ok(findings.some(f => f.rule === 'routing' && /all 4 written parts/.test(f.msg)));
});

test('the conductor reading through the shell is counted; heredocs and gates are not', () => {
  assert.ok(isShellRead('git show abc123'));
  assert.ok(isShellRead('Get-Content report.md'));
  assert.ok(!isShellRead("cat > brief.txt <<'EOF'\nx\nEOF"));
  assert.ok(!isShellRead('node close_part.js board.md A'));
  assert.ok(!isShellRead('git status --short'));
  const calls = Array.from({ length: 20 }, (_, i) => use(i, 'c' + i, 'Bash', { command: i < 10 ? 'git diff HEAD~1' : 'npm test' }));
  const { facts, findings } = audit(fixture(calls), ['s1'], {});
  assert.strictEqual(facts.conductor.shellReads, 10);
  assert.ok(findings.some(f => f.rule === 'conductor-reads' && /10 of 20/.test(f.msg)));
});

test('close_part.js counts as the gate and the board check', () => {
  const proj = fixture([
    use(1, 'w1', 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(2, 'w1', 'ok'),
    use(3, 'r1', 'Bash', { command: `codex exec -m gpt-x ${R}` }), res(4, 'r1', 'ok'),
    use(5, 'k1', 'Bash', { command: 'node close_part.js b.md A --repo . --review r.json' }), res(5, 'k1', '{"ok":false,"part":"A","verdict":"REVISE"}'),
  ]);
  const { facts, findings } = audit(proj, ['s1'], { codexModel: 'gpt-x' });
  assert.strictEqual(facts.gates, 1);
  assert.strictEqual(facts.revisesGated, 1);
  assert.ok(!findings.some(f => f.rule === 'gate'));
});

test('Codex tokens, models and quota come from Codex\'s own files, inside the window only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-home-')), d = path.join(home, '.codex', 'sessions', '2026', '10', '28');
  fs.mkdirSync(d, { recursive: true });
  const usage = (ts, input, output, used) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: output } }, rate_limits: { primary: { used_percent: used }, secondary: { used_percent: 50 } } } });
  const run = (name, start, model, effort, ...rest) => write(d, name, [{ timestamp: start, type: 'session_meta', payload: {} }, { timestamp: start, type: 'turn_context', payload: { model, effort } }, ...rest]);
  run('rollout-a.jsonl', T(5), 'gpt-x', 'medium', usage(T(6), 100, 5, 40), usage(T(9), 200, 20, 60));
  run('rollout-b.jsonl', T(30), 'gpt-light', 'low', usage(T(31), 300, 30, 70));
  run('rollout-out.jsonl', '2026-10-28T23:00:00.000Z', 'gpt-x', 'high', usage('2026-10-28T23:05:00.000Z', 9999, 9999, 99));
  const r = codexRollouts(T(0), T(40), home);
  assert.strictEqual(r.runs, 2);
  assert.deepStrictEqual(r.byModel, { 'gpt-x': 220, 'gpt-light': 330 });
  assert.deepStrictEqual(r.byEffort, { medium: 1, low: 1 });
  assert.deepStrictEqual(r.quota, { windowPct: 70, weeklyPct: 50 });
  assert.strictEqual(r.cachedTokens, 20);
  const proj = fixture([asst(0, 1000), asst(40, 1000)]);
  assert.match(render(audit(proj, ['s1'], { codexHome: home })), /2 runs · 0\.00 M tokens .*quota used: 70% of 5 h, 50% of week/);
  assert.strictEqual(audit(proj, ['s1'], {}).facts.codexRollouts, undefined);
});

test('plan consultation: 3+ parts need both advisors or a written skip reason', () => {
  const w = i => [use(i, 'w' + i, 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(i + 1, 'w' + i, 'ok')];
  const parts = [...w(1), ...w(3), ...w(5)];
  const codex = use(10, 'c1', 'Bash', { command: 'codex exec -m gpt-x -c model_reasoning_effort=medium -s read-only -o s/consult-codex.md - < consult.txt' });
  const claude = use(11, 'c2', 'Agent', { description: 'advise', subagent_type: 'orkestra:advisor' });
  const board = content => use(0, 'b' + content.length, 'Write', { file_path: 'C:/s/job/board.md', content });
  const warns = lines => audit(fixture(lines), ['s1'], { codexModel: 'gpt-x' }).findings.filter(f => f.rule === 'consult');

  assert.strictEqual(parseCodex(codex.message.content[0].input.command).role, 'consult');
  assert.match(warns(parts)[0].msg, /3 parts .*without consulting/);
  assert.match(warns([...parts, codex])[0].msg, /only one advisor \(Codex\)/);
  assert.match(warns([...parts, claude])[0].msg, /only one advisor \(Claude\)/);
  assert.deepStrictEqual(warns([...parts, codex, claude]), []);
  assert.deepStrictEqual(warns([board('- Consultation skipped (reason): three independent one-line fixes\n'), ...parts]), []);
  assert.strictEqual(warns([board('- Consultation skipped (reason):\n\n| Advisor |\n'), ...parts]).length, 1);   // the template's empty line
  assert.deepStrictEqual(warns(w(1)), []);                                                                      // small jobs are not asked
  const { facts } = audit(fixture([...parts, codex, claude]), ['s1'], { codexModel: 'gpt-x' });
  assert.deepStrictEqual(facts.consults, { codex: 1, claude: 1, skipped: false });
  assert.strictEqual(facts.reviews, 0);                                                                         // a consult is not a code review
});

test('hierarchy is audited: a section lead\'s Codex runs count, one review covers its section', () => {
  const G = 'node guarded.js codex --minutes 25 -- codex exec -m gpt-x';
  const lead = [1, 2, 3, 4].flatMap(i => [use(10 + i, 'lw' + i, 'Bash', { command: `${G} ${W}` }), res(11 + i, 'lw' + i, 'ok')]);
  const proj = fixture([
    use(1, 'a1', 'Agent', { description: 'section S1', subagent_type: 'orkestra:section-lead' }),
    use(30, 'rv', 'Agent', { description: 'review S1', subagent_type: 'orkestra:reviewer' }),
  ], [['section S1', 'orkestra:section-lead', [...sub(2, 25, 'claude-sonnet-x'), ...lead]]]);
  const { facts, findings } = audit(proj, ['s1'], { codexModel: 'gpt-x' });
  assert.strictEqual(facts.codex.filter(c => c.role === 'writer').length, 4);
  assert.strictEqual(facts.sectionLeads, 1);
  assert.strictEqual(facts.unguarded, 0);
  assert.ok(!findings.some(f => f.rule === 'review' || f.rule === 'guarded'));
  const noReview = audit(fixture([use(1, 'a1', 'Agent', { description: 'section S1', subagent_type: 'orkestra:section-lead' })], [['section S1', 'orkestra:section-lead', [...sub(2, 25, 'claude-sonnet-x'), ...lead]]]), ['s1'], { codexModel: 'gpt-x' });
  assert.ok(noReview.findings.some(f => f.level === 'FAIL' && f.rule === 'review'));
});

test('guarded runs are recognised; bare Codex runs are flagged; guarded heavy runs count as low priority', () => {
  assert.ok(CODEX_CALL.test('node "C:/x y/guarded.js" codex --minutes 25 -- codex exec -m g - < b.txt'));
  assert.ok(!CODEX_CALL.test('node guarded.js codex -- codex exec --help'));
  assert.ok(!CODEX_CALL.test('node guarded.js quota'));
  const { facts, findings } = audit(fixture([
    use(1, 'w1', 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(2, 'w1', 'ok'),
    use(3, 'h1', 'Bash', { command: 'node guarded.js heavy --minutes 25 -- python tools/smoke.py' }),
  ]), ['s1'], { codexModel: 'gpt-x' });
  assert.ok(findings.some(f => f.rule === 'guarded' && /1 of 1/.test(f.msg)));
  assert.strictEqual(facts.heavyRuns, 1);
  assert.strictEqual(facts.heavyNormal, 0);
});

test('two written parts need a final review, from either vendor', () => {
  const w = i => [use(i, 'w' + i, 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(i + 1, 'w' + i, 'ok')];
  const parts = [...w(1), ...w(3)];
  const has = lines => audit(fixture(lines), ['s1'], { codexModel: 'gpt-x' }).findings.some(f => f.rule === 'final-review');
  assert.ok(has(parts));
  assert.ok(!has(w(1)));
  assert.ok(!has([...parts, use(9, 'f1', 'Agent', { description: 'final review', subagent_type: 'orkestra:reviewer' })]));
  assert.ok(!has([...parts, use(9, 'f2', 'Bash', { command: 'codex exec -m gpt-x -c model_reasoning_effort=high -s read-only --output-schema s.json -o review-final.json - < r.txt' })]));
});

test('a handoff announced without the handoff check is flagged; the check is not counted as a merge gate', () => {
  const said = { type: 'assistant', timestamp: T(5), message: { id: 'h', content: [{ type: 'text', text: 'open a new session and say: /orkestra:orkestra continue from C:/b.md' }] } };
  const check = use(4, 'c1', 'Bash', { command: 'node board_check.js C:/b.md --handoff --repo .' });
  assert.ok(audit(fixture([said]), ['s1'], {}).findings.some(f => f.rule === 'handoff'));
  const r = audit(fixture([check, said]), ['s1'], {});
  assert.ok(!r.findings.some(f => f.rule === 'handoff'));
  assert.strictEqual(r.facts.handoffChecks, 1);
  assert.strictEqual(r.facts.boardChecks, 0);
});

test('the board template still parses: the consultation table is not the parts table', () => {
  const { partsTable } = require('../skills/orkestra/board_check.js');
  const rows = partsTable(fs.readFileSync(path.join(__dirname, '../skills/orkestra/templates/board.md'), 'utf8'));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].state, 'ready');
});

test('code written without any review is a FAIL, partial review a WARN', () => {
  const w = i => [use(i, 'w' + i, 'Bash', { command: `codex exec -m gpt-x ${W}` }), res(i + 1, 'w' + i, 'ok')];
  const none = audit(fixture([...w(1), ...w(3)]), ['s1'], { codexModel: 'gpt-x' }).findings;
  assert.ok(none.some(f => f.level === 'FAIL' && f.rule === 'review'));
  const some = audit(fixture([...w(1), ...w(3), use(5, 'r1', 'Bash', { command: `codex exec -m gpt-x ${R}` }), res(6, 'r1', 'ok')]), ['s1'], { codexModel: 'gpt-x' }).findings;
  assert.ok(some.some(f => f.level === 'WARN' && f.rule === 'review' && /2 Codex writes but only 1/.test(f.msg)));
});

test('a Codex run guarded.js refused is not a run or a review; the empty board template is not a design note', () => {
  const tpl = '## Design note (only for ambiguous jobs)\n- Goal:\n- Chosen approach:\n';
  const proj = fixture([
    asst(0, 50_000),
    use(1, 'b1', 'Write', { file_path: 'C:/s/job/board.md', content: tpl }),
    use(2, 'r1', 'Bash', { command: `node guarded.js codex --minutes 25 -- codex exec -m gpt-x ${R}` }), res(3, 'r1', '{"guarded":"quota","started":false,"blocked":["window 85%"]}'),
    asst(5, 60_000),
  ]);
  const { facts } = audit(proj, ['s1'], { codexModel: 'gpt-x' });
  assert.strictEqual(facts.reviews, 0);
  assert.strictEqual(facts.codex.length, 0);
  assert.strictEqual(facts.codexRefused, 1);
  assert.strictEqual(facts.designNote, false);
});

// The second pilot's false warnings: a board kept by scripts, a docs part, Claude reviewing Claude.
const boardWith = rows => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-board-')), b = path.join(dir, 'board.md').split(path.sep).join('/');
  fs.writeFileSync(b, '| Part | parallel? | write surface | domain | risk |\n|---|---|---|---|---|\n' + rows.map(([p, d]) => `| ${p} | yes | x | ${d} | low |`).join('\n') + '\n');
  return b;
};
const twoWorkers = [['write part A', 'orkestra:worker', sub(3, 5, 'claude-sonnet-x')], ['write part B', 'orkestra:worker', sub(3, 5, 'claude-haiku-x')]];
const pilot = (b, reviewer) => fixture([
  asst(0, 50_000),
  use(1, 'n1', 'Bash', { command: `node new_job.js --repo . pilot` }), res(1, 'n1', `{"dir":"x","board":"${b}","created":true}`),
  use(2, 'a1', 'Agent', { description: 'write part A', subagent_type: 'orkestra:worker', model: 'sonnet' }),
  use(2, 'a2', 'Agent', { description: 'write part B', subagent_type: 'orkestra:worker', model: 'haiku' }),
  use(6, 'r1', 'Agent', { description: 'review part A', subagent_type: 'orkestra:reviewer' }),
  reviewer === 'codex' ? use(7, 'r2', 'Bash', { command: `node guarded.js codex -- codex exec -m gpt-x ${R}` }) : use(7, 'r2', 'Agent', { description: 'review part B', subagent_type: 'orkestra:reviewer' }),
  res(8, 'r2', 'tokens used\n10'),
  use(9, 'c1', 'Bash', { command: `node close_part.js ${b} A --repo . --review review-A.json` }), res(9, 'c1', '{"ok":true}'),
  asst(10, 60_000),
], twoWorkers);

test('a board kept by scripts is a board; only code parts call for a final review; Claude reviewing Claude is flagged', () => {
  let { findings } = audit(pilot(boardWith([['A', 'code'], ['B', 'docs']]), 'claude'), ['s1'], { codexModel: 'gpt-x' });
  assert.ok(!findings.some(f => f.rule === 'board'), JSON.stringify(findings));
  assert.ok(!findings.some(f => f.rule === 'final-review'), JSON.stringify(findings));
  assert.ok(findings.some(f => f.rule === 'routing' && /reviews came from Claude while Claude workers/.test(f.msg)));
  ({ findings } = audit(pilot(boardWith([['A', 'code'], ['B', 'code']]), 'codex'), ['s1'], { codexModel: 'gpt-x' }));
  assert.ok(findings.some(f => f.rule === 'final-review' && /2 parts wrote code/.test(f.msg)), JSON.stringify(findings));
  assert.ok(!findings.some(f => f.rule === 'routing' && /came from Claude/.test(f.msg)));
});

test('same-vendor reviews with the reason written on the board are a decision, not a warning', () => {
  const b = boardWith([['A', 'code'], ['B', 'docs']]);
  fs.appendFileSync(b, '\n## Decisions\n- Ruling: reviews stay with Claude (same vendor) — AGENTS.md keeps Codex for hard problems — cost if wrong: one missed bug\n');
  const { facts, findings } = audit(pilot(b, 'claude'), ['s1'], { codexModel: 'gpt-x' });
  assert.ok(!findings.some(f => f.rule === 'routing'), JSON.stringify(findings));
  assert.match(facts.sameVendorReason, /same vendor/);
});

test('the vendor warning stays when the board forbids same-vendor review or names the wrong vendor', () => {
  for (const line of [
    '- Ruling: same-vendor reviews are prohibited in this project',
    '- Ruling: Claude was unavailable for reviews (quota), so reviews stayed with one vendor',   // Claude reviewed: wrong vendor named
    '- Note: Codex quota was fine today',                                                       // not a decision
    '- Ruling: Codex is available for reviews and has quota (same vendor anyway)',              // no reason
  ]) {
    const b = boardWith([['A', 'code'], ['B', 'docs']]);
    fs.appendFileSync(b, '\n## Decisions\n' + line + '\n');
    const { findings } = audit(pilot(b, 'claude'), ['s1'], { codexModel: 'gpt-x' });
    assert.ok(findings.some(f => f.rule === 'routing' && /came from Claude/.test(f.msg)), line);
  }
});

test('a worker resumed several times is timed per run; a Codex call that returned at once is "not timed", not 0', () => {
  const { runsOf } = require('../skills/orkestra/audit_run.js');
  const prompt = min => ({ type: 'user', timestamp: T(min), message: { content: 'continue with the fix' } });
  const resumed = [prompt(0), asst(1, 1000, 'low', 'claude-sonnet-x'), asst(20, 1000, 'low', 'claude-sonnet-x'), prompt(30), asst(31, 1000, 'low', 'claude-sonnet-x'), asst(50, 1000, 'low', 'claude-sonnet-x')];
  assert.deepStrictEqual(runsOf(resumed).length, 2);
  let { facts, findings } = audit(fixture([asst(0, 50_000), asst(60, 60_000)], [['write part B', 'orkestra:worker', resumed]]), ['s1'], {});
  assert.ok(!findings.some(f => f.rule === 'time-limit'), JSON.stringify(findings));
  assert.strictEqual(facts.subagents[0].runs, 2);
  const oneGo = [prompt(0), asst(1, 1000, 'low', 'claude-sonnet-x'), asst(35, 1000, 'low', 'claude-sonnet-x')];
  ({ findings } = audit(fixture([asst(0, 50_000), asst(60, 60_000)], [['write part C', 'orkestra:worker', oneGo]]), ['s1'], {}));
  assert.ok(findings.some(f => f.rule === 'time-limit' && /in one go/.test(f.msg)));
  ({ facts } = audit(fixture([asst(0, 50_000), use(1, 'i1', 'Bash', { command: `node guarded.js codex -- codex exec -m gpt-x -s workspace-write -i ref.png - < look.txt > look.log 2>&1` }), res(1, 'i1', ''), asst(5, 60_000)]), ['s1'], { codexModel: 'gpt-x' }));
  assert.strictEqual(facts.codex[0].role, 'image');
  assert.strictEqual(facts.codex[0].minutes, null);
  assert.strictEqual(facts.codex[0].untimed, true);
});

test('a system reminder is not a new run, and the wait before a resumption is not parallel work', () => {
  const { runsOf } = require('../skills/orkestra/audit_run.js');
  const prompt = (min, text) => ({ type: 'user', timestamp: T(min), message: { content: text } });
  const reminded = [prompt(0, 'write part B'), asst(1, 1000, 'low', 'claude-sonnet-x'), prompt(10, '<system-reminder>\nLinked sessions now\n</system-reminder>'), asst(40, 1000, 'low', 'claude-sonnet-x')];
  assert.strictEqual(runsOf(reminded).length, 1);
  const { findings } = audit(fixture([asst(0, 50_000), asst(60, 60_000)], [['write part B', 'orkestra:worker', reminded]]), ['s1'], {});
  assert.ok(findings.some(f => f.rule === 'time-limit' && /40 min in one go/.test(f.msg)), JSON.stringify(findings));
  // Three agents busy from 20 to 30 while a fourth waits between its runs (0-5 and 40-45): never four at once.
  const busy = d => [prompt(20, 'go'), asst(21, 1000, 'low', 'claude-sonnet-x'), asst(30, 1000, 'low', 'claude-sonnet-x')];
  const resumed = [prompt(0, 'go'), asst(5, 1000, 'low', 'claude-sonnet-x'), prompt(40, 'continue'), asst(45, 1000, 'low', 'claude-sonnet-x')];
  const { facts } = audit(fixture([asst(0, 50_000), asst(60, 60_000)], [['a', 'orkestra:worker', busy()], ['b', 'orkestra:worker', busy()], ['c', 'orkestra:worker', busy()], ['d', 'orkestra:worker', resumed]]), ['s1'], {});
  assert.strictEqual(facts.maxParallelClaude, 3);
});

const userTurn = (min, content) => ({ type: 'user', timestamp: T(min), message: { content } });
const taskNotice = (id, status = 'running') =>
  `<task-notification>\n${id ? `<task-id>${id}</task-id>\n` : ''}<status>${status}</status>\n</task-notification>`;

test('idle_wakes counts harness responses with no tools or only a previously read path', () => {
  const waiting = asst(3, 1_000);
  const proj = fixture([
    asst(0, 100_000), // no visible trigger
    userTurn(1, 'Read the notes'), use(1, 'first', 'Read', { file_path: 'C:/sample/notes.md' }),
    userTurn(2, taskNotice('a')), waiting, waiting,
    userTurn(4, [{ type: 'text', text: '<system-reminder>Waiting</system-reminder>' }]), asst(5, 2_000),
    userTurn(6, '<hook-output>Waiting</hook-output>'), asst(7, 3_000),
    use(8, 'repeat', 'Read', { file_path: 'C:\\sample\\notes.md' }), res(8, 'repeat', 'notes'),
    userTurn(9, taskNotice('b')), asst(10, 4_000), use(11, 'busy', 'Bash', { command: 'git status' }),
    userTurn(12, taskNotice('c')), asst(13, 5_000), use(14, 'new', 'Read', { file_path: 'other.md' }),
    userTurn(15, 'Still waiting'), asst(16, 6_000),
    userTurn(17, '<system-reminder>Waiting</system-reminder>Any news?'), asst(18, 7_000),
    userTurn(19, '<unrecognized-event>Waiting</unrecognized-event>'), asst(20, 8_000),
    userTurn(21, taskNotice('d')), // never answered
  ], [['subagent', 'orkestra:worker', [userTurn(2, taskNotice('a')), asst(3, 12_000, 'low', 'claude-sonnet-x')]]]);
  const result = audit(proj, ['s1'], {});
  const { facts, findings } = result;
  assert.deepStrictEqual(facts.idleWakes?.examples, [T(3), T(5), T(7)]);
  assert.strictEqual(facts.idleWakes.count, 3);
  assert.strictEqual(facts.idleWakes.cacheReads, 6_000);
  assert.strictEqual(facts.idleWakes.unknown, 2);
  assert.ok(facts.idleWakes.sharePct < 10);
  assert.ok(findings.some(f => f.level === 'WARN' && f.rule === 'idle_wakes'));
  assert.match(render(result), /3 idle wakes used 6000 cache reads/);
});

test('idle_wakes warns at 10% of conductor cache reads even with only one idle wake', () => {
  const lines = [userTurn(0, 'Start'), asst(1, 90_000),
    userTurn(2, '<background-task-completion>Done</background-task-completion>'), asst(3, 10_000)];
  const result = audit(fixture(lines), ['s1'], {});
  assert.ok(result.findings.some(f => f.level === 'WARN' && f.rule === 'idle_wakes'));
  const below = audit(fixture([...lines, userTurn(4, 'Continue'), asst(5, 1_000)]), ['s1'], {});
  assert.strictEqual(below.facts.idleWakes.count, 1);
  assert.ok(!below.findings.some(f => f.rule === 'idle_wakes'));
});

test('repeat_notices counts interim notices by task, including queued notices, once per delivery', () => {
  const first = taskNotice('a');
  const entries = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: T(1), content: first },
    userTurn(2, first), userTurn(3, taskNotice('a')), userTurn(4, taskNotice('b')),
    userTurn(5, taskNotice('a')), userTurn(6, taskNotice('a', 'completed')),
    userTurn(7, taskNotice('a')), userTurn(8, taskNotice()), userTurn(9, taskNotice('b', 'completed')),
  ];
  const result = audit(fixture(entries), ['s1'], {});
  assert.deepStrictEqual(result.facts.repeatNotices, { counts: { a: 3, b: 1 }, skipped: 1 });
  assert.deepStrictEqual(result.findings.filter(f => f.rule === 'repeat_notices').map(f => f.level), ['WARN', 'INFO']);
  assert.match(render(result), /task a sent 3 notices before completion/);
  assert.match(render(result), /skipped 1 task notification\(s\) without a task id/);
  const below = audit(fixture(entries.filter(e => e.timestamp !== T(5))), ['s1'], {});
  assert.ok(!below.findings.some(f => f.rule === 'repeat_notices' && f.level === 'WARN'));
});
