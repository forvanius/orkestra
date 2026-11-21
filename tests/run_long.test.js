const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const runner = path.resolve(__dirname, '../skills/orkestra/run_long.js');
const node = process.execPath;

function fixture(t, source) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'long run '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const script = path.join(cwd, 'child script.js');
  fs.writeFileSync(script, source);
  const log = path.join(cwd, 'nested dir', 'run.log');
  return { cwd, log, script, done: `${log}.done.json` };
}

function invoke(args, cwd) {
  const result = spawnSync(node, [runner, ...args], { cwd, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

function lines(stdout) {
  return stdout.trimEnd().split(/\r?\n/);
}

test('run_long prints nothing while a child that has written output is still running', async t => {
  const { cwd, log, script, done } = fixture(t, `
    const fs = require('node:fs');
    process.stdout.write('child stdout\\n');
    process.stderr.write('child stderr\\n');
    const wait = setInterval(() => {
      if (fs.existsSync('release')) clearInterval(wait);
    }, 20);
  `);
  const cmd = [node, script];
  const child = spawn(node, [runner, '--log', path.relative(cwd, log), '--minutes', '0.08', '--', ...cmd], { cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  let childWrote = false;
  try {
    for (let i = 0; i < 150 && !childWrote; i++) {
      await delay(20);
      childWrote = fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('child stderr\n');
    }
    assert.equal(childWrote, true);
    await delay(100);
    assert.equal(child.exitCode, null);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    assert.equal(fs.existsSync(done), false);
  } finally {
    fs.writeFileSync(path.join(cwd, 'release'), '');
    await closed;
  }
  assert.deepEqual(await closed, [0, null]);
  assert.equal(stderr, '');
  const metadata = JSON.parse(fs.readFileSync(done, 'utf8'));
  assert.deepEqual(Object.keys(metadata).sort(), ['cmd', 'exit', 'finishedAt', 'minutes', 'timedOut']);
  assert.deepEqual(metadata.cmd, cmd);
  assert.equal(metadata.exit, 0);
  assert.equal(metadata.timedOut, false);
  assert.ok(Number.isFinite(metadata.minutes) && metadata.minutes > 0);
  assert.equal(new Date(metadata.finishedAt).toISOString(), metadata.finishedAt);
  assert.deepEqual(lines(stdout), [`run_long: exit=0 minutes=${metadata.minutes.toFixed(1)} log=${log}`, '  child stdout', '  child stderr']);
});

test('run_long passes exit 3 through and tails non-empty log lines', t => {
  const { cwd, log, script, done } = fixture(t, `
    process.stdout.write('first\\r\\n\\r\\n' + JSON.stringify(process.argv.slice(2)) + '\\r\\n');
    process.stderr.write('last\\r\\n  \\r\\n');
    process.exitCode = 3;
  `);
  const args = ['folder with spaces\\', 'say "hello"', '', 'a&b %PATH%'];
  fs.mkdirSync(path.dirname(log));
  fs.writeFileSync(log, 'old run');
  const result = invoke(['--log', log, '--tail', '2', '--', node, script, ...args], cwd);
  assert.equal(result.status, 3);
  assert.equal(result.stderr, '');
  const metadata = JSON.parse(fs.readFileSync(done, 'utf8'));
  assert.equal(metadata.exit, 3);
  assert.deepEqual(lines(result.stdout), [`run_long: exit=3 minutes=${metadata.minutes.toFixed(1)} log=${log}`, `  ${JSON.stringify(args)}`, '  last']);
  assert.equal(fs.readFileSync(log, 'utf8'), `first\r\n\r\n${JSON.stringify(args)}\r\nlast\r\n  \r\n`);
});

test('run_long defaults to 8 tail lines and caps the tail at 40', t => {
  const { cwd, log, script } = fixture(t, `
    for (let i = 1; i <= 45; i++) console.log('line ' + i);
  `);
  for (const [flags, count] of [[[], 8], [['--tail', '45'], 40]]) {
    const result = invoke(['--log', log, ...flags, '--', node, script], cwd);
    assert.equal(result.status, 0);
    assert.deepEqual(lines(result.stdout).slice(1), Array.from({ length: count }, (_, i) => `  line ${46 - count + i}`));
  }
});

test('run_long kills the process tree on timeout, exits 124 and writes completion metadata', async t => {
  const { cwd, log, script, done } = fixture(t, `
    const { spawn } = require('node:child_process');
    const sleeper = spawn(process.execPath, ['sleeper.js'], { stdio: 'inherit' });
    sleeper.once('spawn', () => console.log('started sleeper'));
    setTimeout(() => {}, 2600);
  `);
  fs.writeFileSync(path.join(cwd, 'sleeper.js'), `
    setTimeout(() => require('node:fs').writeFileSync('survived', ''), 1500);
  `);
  const cmd = [node, script];
  const result = invoke(['--log', log, '--minutes', '0.02', '--', ...cmd], cwd);
  assert.equal(result.status, 124, result.stderr);
  assert.equal(result.stderr, '');
  const metadata = JSON.parse(fs.readFileSync(done, 'utf8'));
  assert.deepEqual(metadata.cmd, cmd);
  assert.equal(metadata.exit, null);
  assert.equal(metadata.timedOut, true);
  assert.ok(metadata.minutes >= 0.02);
  assert.deepEqual(lines(result.stdout), [`run_long: timeout minutes=${metadata.minutes.toFixed(1)} log=${log}`, '  started sleeper']);
  await delay(750);
  assert.equal(fs.existsSync(path.join(cwd, 'survived')), false);
});

if (process.platform === 'win32') {
  test('run_long uses the Windows shell for .cmd paths and quoted arguments', t => {
    const { cwd, log, script } = fixture(t, 'console.log(process.argv[2]);');
    const shim = path.join(cwd, 'test tool.cmd');
    fs.writeFileSync(shim, '@"%~1" "%~2" "%~3"\r\n');
    const result = invoke(['--log', log, '--', shim, node, script, 'two words'], cwd);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(lines(result.stdout).slice(1), ['  two words']);
  });
}

test('run_long rejects missing log or command with exit 2 and one usage line', () => {
  for (const args of [[], ['--', node], ['--log', 'run.log'], ['--log', 'run.log', '--']]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^usage: node run_long\.js [^\r\n]+\r?\n$/);
  }
});
