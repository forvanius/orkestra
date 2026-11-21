const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const skillDir = path.join(__dirname, '..', 'skills', 'orkestra');
const run = (script, ...args) => JSON.parse(execFileSync(
  process.execPath, [path.join(skillDir, script), ...args], { encoding: 'utf8' },
));

test('new_job board works with the budget and dispatch commands once filled in', t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orkestra template '));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);

  const { board, created } = run('new_job.js', '--repo', repo, 'template');
  assert.equal(created, true);
  const template = fs.readFileSync(board, 'utf8').replace(/\r\n/g, '\n');
  assert.match(template, /^## Budget\n- Estimate: claude_reads=<N>M conductor=<N>M time=<N>h$/m,
    'Budget section missing or Estimate format changed');
  assert.match(template, /^## Real-world test\n- Where\/how:\n- Try-note:$/m);

  // Fill the existing template rows as the conductor does when planning.
  const planned = template
    .replace('- Mode:', '- Mode: auto')
    .replace('| A |  |  |  |  |  |  |  |  |', '| A | yes | src/task.js | code | low | writer | codex | reviewer | node --test |')
    .replace('claude_reads=<N>M conductor=<N>M time=<N>h', 'claude_reads=25M conductor=12.5M time=3h');
  fs.writeFileSync(board, planned);
  assert.deepEqual(run('next_parts.js', board).start, ['A']);

  const transcripts = path.join(repo, 'fixture transcripts');
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(transcripts, 'session.jsonl'), JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-21T10:00:00Z',
    message: { id: 'sample', model: 'claude-sonnet', usage: { cache_read_input_tokens: 1000000 } },
  }) + '\n');
  const { budget } = run('usage_sum.js', transcripts, 'session', '--budget', board, '--json');
  assert.deepEqual(budget, {
    claude_reads: { spent: 1, estimate: 25, pct: 4 },
    conductor: { spent: 1, estimate: 12.5, pct: 8 },
    time: { spent: 0, estimate: 3 },
  });
});

test('writer brief requests a text report and a constraints checklist', () => {
  const brief = fs.readFileSync(path.join(skillDir, 'templates', 'brief.txt'), 'utf8');
  assert.match(brief, /report-<part>\.txt/);
  assert.match(brief, /^CONSTRAINTS CHECKLIST\b/m);
});
