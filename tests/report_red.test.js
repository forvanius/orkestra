// node --test tests/report_red.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { takeReport } = require('../skills/orkestra/take_report.js');
const { redCheck } = require('../skills/orkestra/red_check.js');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('a report written in the agent\'s own tree is taken into the job folder; a missing one is an error', () => {
  const job = path.join(tmp('ork-job-'), '.orkestra', 'pilot'); fs.mkdirSync(job, { recursive: true });
  const tree = tmp('ork-tree-'); fs.mkdirSync(path.join(tree, '.orkestra', 'pilot'), { recursive: true });
  fs.writeFileSync(path.join(tree, '.orkestra', 'pilot', 'report-A.md'), 'A done');
  let r = takeReport(job, 'report-A', tree);
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(r.out.copied, true);
  assert.strictEqual(fs.readFileSync(path.join(job, 'report-A.md'), 'utf8'), 'A done');
  r = takeReport(job, 'report-A');                       // already there: nothing to copy
  assert.deepStrictEqual([r.code, r.out.copied], [0, false]);
  r = takeReport(job, 'report-B', tree);                 // the agent said it wrote one, but didn't
  assert.strictEqual(r.code, 1);
  assert.match(r.out.errors[0], /did not write it/);
  assert.strictEqual(takeReport(job, 'report-B').code, 1);
  assert.strictEqual(takeReport(job, '../x', tree).code, 2);
  assert.strictEqual(takeReport(path.join(job, 'nope'), 'report-A').code, 2);
});

function repo() {
  const dir = tmp('ork-red-repo-');
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'lib.js'), 'module.exports = x => x + 1;\n');          // the bug: +1
  fs.writeFileSync(path.join(dir, 'other.test.js'), 'process.exit(0);\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'lib.js'), 'module.exports = x => x + 2;\n');          // the fix
  fs.writeFileSync(path.join(dir, 'helper.js'), 'module.exports = 2;\n');                // new with the fix
  fs.writeFileSync(path.join(dir, 'lib.test.js'), "process.exit(require('./lib.js')(1) === 3 ? 0 : 1);\n");
  g('add', '-A'); g('commit', '-qm', 'fix');
  return { dir, base, g };
}

test('red check: green with the fix, red without it, and every file restored as it was', () => {
  const r = repo();
  fs.appendFileSync(path.join(r.dir, 'lib.js'), '// an uncommitted edit\n');           // must survive the check
  const before = fs.readFileSync(path.join(r.dir, 'lib.js'), 'utf8');
  const res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js', 'helper.js'], cmd: 'node lib.test.js' });
  assert.strictEqual(res.code, 0, JSON.stringify(res.out));
  assert.deepStrictEqual([res.out.green, res.out.red, res.out.restored], [true, true, true]);
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'lib.js'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(r.dir, 'helper.js')), 'a file new with the fix comes back');
  assert.strictEqual(r.g('status', '--porcelain'), 'M lib.js');
});

test('red check: a test that does not catch the bug, or fails with the fix, is refused', () => {
  const r = repo();
  let res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node other.test.js' });
  assert.strictEqual(res.code, 1);
  assert.match(res.out.errors[0], /does not catch the bug/);
  assert.strictEqual(r.g('status', '--porcelain'), '');
  res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node -e "process.exit(1)"' });
  assert.strictEqual(res.code, 1);
  assert.match(res.out.errors[0], /fails WITH the fix/);
  assert.strictEqual(redCheck({ repo: r.dir, base: r.base, files: ['../x'], cmd: 'node lib.test.js' }).code, 2);
  assert.strictEqual(redCheck({ repo: r.dir, base: r.base, files: [], cmd: 'node lib.test.js' }).code, 2);
});

test('with --from only this round\'s report counts: no stale copy, no folder posing as a report', () => {
  const job = path.join(tmp('ork-job-'), '.orkestra', 'pilot'); fs.mkdirSync(job, { recursive: true });
  const tree = tmp('ork-tree-'), own = path.join(tree, '.orkestra', 'pilot'); fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(job, 'report-A.md'), 'round one');                  // round two never wrote its own
  let r = takeReport(job, 'report-A', tree);
  assert.strictEqual(r.code, 1, JSON.stringify(r.out));
  fs.mkdirSync(path.join(own, 'report-A.md'));                                   // a folder is not a report
  assert.strictEqual(takeReport(job, 'report-A', tree).code, 1);
  fs.mkdirSync(path.join(job, 'report-C.md'));
  assert.strictEqual(takeReport(job, 'report-C').code, 1);
  fs.writeFileSync(path.join(own, 'research.md'), 'answers');                    // a brief may name the file with .md
  assert.strictEqual(takeReport(job, 'research.md', tree).code, 0);
  assert.strictEqual(takeReport(job, 'research', '').code, 2);                   // --from with no tree after it
});

test('red check: an interrupted run is restored by --restore, and a test that rewrites other files is not trusted', () => {
  const { restore } = require('../skills/orkestra/red_check.js');
  const r = repo(), lib = path.join(r.dir, 'lib.js'), fixed = fs.readFileSync(lib, 'utf8');
  // Simulate a run killed after it put BASE in place: the manifest and the copy are left behind.
  const keep = path.join(r.dir, '.git', 'orkestra-red-check'); fs.mkdirSync(keep, { recursive: true });
  fs.copyFileSync(lib, path.join(keep, '0'));
  fs.writeFileSync(path.join(keep, 'manifest.json'), JSON.stringify([{ abs: lib, had: true, copy: '0' }]));
  fs.writeFileSync(lib, 'module.exports = x => x + 1;\n');
  let res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node lib.test.js' });
  assert.strictEqual(res.code, 2);
  assert.match(res.out.errors[0], /interrupted/);
  assert.strictEqual(restore(r.dir).code, 0);
  assert.strictEqual(fs.readFileSync(lib, 'utf8'), fixed);
  assert.ok(!fs.existsSync(keep));
  // A test that rewrites a tracked file outside --revert.
  fs.writeFileSync(path.join(r.dir, 'side.test.js'), "require('fs').appendFileSync('other.test.js', '// rewritten');\nprocess.exit(require('./lib.js')(1) === 3 ? 0 : 1);\n");
  res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node side.test.js' });
  assert.strictEqual(res.code, 1);
  assert.match(res.out.errors[0], /changed tracked files/);
  assert.strictEqual(fs.readFileSync(lib, 'utf8'), fixed);
  // From the command line the test command is one quoted string; loose words are refused, not guessed at.
  const cli = path.join(__dirname, '..', 'skills', 'orkestra', 'red_check.js');
  const loose = require('child_process').spawnSync(process.execPath, [cli, '--repo', r.dir, '--base', r.base, '--revert', 'lib.js', '--', 'node', 'lib.test.js'], { encoding: 'utf8' });
  assert.strictEqual(loose.status, 2);
  assert.match(loose.stderr, /ONE quoted string/);
  const whole = require('child_process').spawnSync(process.execPath, [cli, '--repo', r.dir, '--base', r.base, '--revert', 'lib.js', '--', 'node lib.test.js'], { encoding: 'utf8' });
  assert.strictEqual(whole.status, 0, whole.stdout + whole.stderr);
});

test('an agent whose write was refused: its whole final message is saved as it came, a summary is not', () => {
  const { saveFinalMessage } = require('../skills/orkestra/take_report.js');
  const job = path.join(tmp('ork-job-'), '.orkestra', 'pilot'); fs.mkdirSync(job, { recursive: true });
  const full = 'Did the edit pipeline; tests in tests/video.\n'.repeat(6) + 'VERDICT: APPROVE\n{"verdict":"APPROVE","checks":[{"cmd":"npm test","exit":0}]}';
  assert.strictEqual(saveFinalMessage(job, 'report-B', 'B done, all good').code, 1);                 // a summary
  assert.strictEqual(saveFinalMessage(job, 'report-B', 'x'.repeat(300)).code, 1);                    // no contract
  const r = saveFinalMessage(job, 'report-B', full);
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.match(fs.readFileSync(path.join(job, 'report-B.md'), 'utf8'), /^<!-- saved by the conductor from the agent's final message/);
  assert.strictEqual(saveFinalMessage(job, 'report-B', full).code, 1);                               // never overwritten
});

test('a summary quoting the verdict mid-sentence is not a report; --file reads UTF-8 as written', () => {
  const { saveFinalMessage } = require('../skills/orkestra/take_report.js');
  const job = path.join(tmp('ork-job-'), '.orkestra', 'pilot'); fs.mkdirSync(job, { recursive: true });
  const quoted = 'The worker finished part B and said VERDICT: APPROVE in its message, tests are fine. '.repeat(4);
  assert.strictEqual(saveFinalMessage(job, 'report-B', quoted).code, 1);
  const msg = path.join(tmp('ork-msg-'), 'message.txt');
  fs.writeFileSync(msg, 'Kurgu hattı: kararma, başlık, ses düzeltildi; çıktı 22,6 sn.\n'.repeat(5) + 'VERDICT: APPROVE\n{"verdict":"APPROVE"}');
  const cli = path.join(__dirname, '..', 'skills', 'orkestra', 'take_report.js');
  const r = require('child_process').spawnSync(process.execPath, [cli, job, 'report-B', '--file', msg], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(job, 'report-B.md'), 'utf8'), /Kurgu hattı: kararma, başlık/);
});

// A fix that adds a helper, and a test whose red comes from a crash, not from a check.
function crashRepo() {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'crash.test.js'), "const h = require('./helper.js');\nprocess.exit(h === 2 ? 0 : 1);\n");   // helper.js is new with the fix
  fs.writeFileSync(path.join(r.dir, 'noisy.test.js'), "console.error('TypeError seen in a log line');\nprocess.exit(require('./lib.js')(1) === 3 ? 0 : 1);\n");
  fs.writeFileSync(path.join(r.dir, 'assert.test.js'), "const assert = require('assert');\nassert.strictEqual(require('./lib.js')(1), 3, 'lib adds two');\n");
  r.g('add', '-A'); r.g('commit', '-qm', 'tests');
  return r;
}

test('red check: a red run that crashes (missing module, ReferenceError ...) is no proof', () => {
  const r = crashRepo();
  const res = redCheck({ repo: r.dir, base: r.base, files: ['helper.js'], cmd: 'node crash.test.js' });
  assert.strictEqual(res.code, 1, JSON.stringify(res.out));
  assert.match(res.out.errors[0], /crashed \(Cannot find module/);
  assert.match(res.out.errors[0], /--expect/);
  assert.strictEqual(r.g('status', '--porcelain'), '');
});

test('red check: an assertion failure is proof, and a crash word the green run also prints is not a crash', () => {
  const r = crashRepo();
  let res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node assert.test.js' });
  assert.strictEqual(res.code, 0, JSON.stringify(res.out));
  res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node noisy.test.js' });
  assert.strictEqual(res.code, 0, JSON.stringify(res.out));
});

test('red check: --expect names the failing check; the red run must show it', () => {
  const r = crashRepo();
  let res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node assert.test.js', expect: 'lib adds two' });
  assert.strictEqual(res.code, 0, JSON.stringify(res.out));
  assert.strictEqual(res.out.expect, 'lib adds two');
  res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node assert.test.js', expect: 'some other check' });
  assert.strictEqual(res.code, 1);
  assert.match(res.out.errors[0], /not with "some other check"/);
  res = redCheck({ repo: r.dir, base: r.base, files: ['helper.js'], cmd: 'node crash.test.js', expect: 'Cannot find module' });
  assert.strictEqual(res.code, 0, 'the conductor says this error is the bug: accepted');
});

// Python's unittest prints a traceback for every failed check; that output is a failed check, not a crash.
// Simulated in node so the suite needs no Python.
const NL = String.fromCharCode(10);
const unittestLike = lines => "const ok = require('./lib.js')(1) === 3;" + NL
  + 'if (!ok) { console.error(' + JSON.stringify(lines.join(NL)) + '); process.exit(1); }' + NL;
const UNITTEST_FAIL = unittestLike(['FAIL: test_adds_two (test_lib.LibTest)', '-'.repeat(70), 'Traceback (most recent call last):', '  File "test_lib.py", line 7, in test_adds_two', '    self.assertEqual(lib(1), 3)', 'AssertionError: 2 != 3', '', 'FAILED (failures=1)']);
const UNITTEST_ERROR = unittestLike(['ERROR: test_adds_two (test_lib.LibTest)', 'Traceback (most recent call last):', '  File "test_lib.py", line 7, in test_adds_two', "NameError: name 'lib2' is not defined", '', 'FAILED (errors=1)']);

test('red check: a unittest-style FAIL with its traceback is proof; a unittest ERROR (NameError) is a crash', () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, 'ut_fail.test.js'), UNITTEST_FAIL);
  fs.writeFileSync(path.join(r.dir, 'ut_error.test.js'), UNITTEST_ERROR);
  r.g('add', '-A'); r.g('commit', '-qm', 'unittest-style tests');
  let res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node ut_fail.test.js' });
  assert.strictEqual(res.code, 0, JSON.stringify(res.out));
  res = redCheck({ repo: r.dir, base: r.base, files: ['lib.js'], cmd: 'node ut_error.test.js' });
  assert.strictEqual(res.code, 1, JSON.stringify(res.out));
  assert.match(res.out.errors[0], /crashed \(.*NameError/);
});

test('a report written as .txt (the harness refuses report-*.md from a subagent) is taken like a .md one', () => {
  const job = path.join(tmp('ork-job-'), '.orkestra', 'pilot'); fs.mkdirSync(job, { recursive: true });
  const tree = tmp('ork-tree-'), own = path.join(tree, '.orkestra', 'pilot'); fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'report-T.txt'), 'T done');
  let r = takeReport(job, 'report-T', tree);
  assert.strictEqual(r.code, 0, JSON.stringify(r.out));
  assert.strictEqual(r.out.copied, true);
  assert.strictEqual(fs.readFileSync(path.join(job, 'report-T.txt'), 'utf8'), 'T done');
  assert.deepStrictEqual([takeReport(job, 'report-T.txt').code, takeReport(job, 'report-T').out.copied], [0, false]);
  assert.strictEqual(takeReport(job, 'report-U', tree).code, 1);
  // --stdin saves the final message from a pipe, verbatim
  const cli = path.join(__dirname, '..', 'skills', 'orkestra', 'take_report.js');
  const msg = 'Did the work, checks pass.\n'.repeat(10) + 'VERDICT: APPROVE\n{"verdict":"APPROVE"}';
  const p = require('child_process').spawnSync(process.execPath, [cli, job, 'report-S', '--stdin'], { input: msg, encoding: 'utf8' });
  assert.strictEqual(p.status, 0, p.stdout + p.stderr);
  assert.match(fs.readFileSync(path.join(job, 'report-S.md'), 'utf8'), /Did the work, checks pass/);
});
