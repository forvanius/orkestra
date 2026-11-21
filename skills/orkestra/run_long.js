#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');

const WIN = process.platform === 'win32';

function parse(argv) {
  const split = argv.indexOf('--');
  if (split < 0 || !argv[split + 1]) return null;
  const options = { minutes: 60, tail: 8, cmd: argv.slice(split + 1) };
  for (let i = 0; i < split; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (i + 1 >= split || !value) return null;
    if (flag === '--log') options.log = path.resolve(value);
    else if (flag === '--minutes') options.minutes = Number(value);
    else if (flag === '--tail') options.tail = Number(value);
    else return null;
  }
  if (!options.log || !Number.isFinite(options.minutes * 60_000) || options.minutes <= 0 ||
      !Number.isInteger(options.tail) || options.tail < 0) return null;
  options.tail = Math.min(options.tail, 40);
  return options;
}

function quoteWindows(arg) {
  if (/^[\w@+=:,./\\-]+$/.test(arg)) return arg;
  // Preserve backslashes before quotes for the command's Windows argv parser.
  const quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&');
  // cmd tracks quotes separately from argv parsing. Protect metacharacters in
  // portions that cmd sees outside quotes, and defer literal percent signs.
  let inQuotes = false;
  return `"${quoted}"`.replace(/["&|<>()^%]/g, char => {
    if (char === '"') inQuotes = !inQuotes;
    if (char === '%') return '%RUN_LONG_PERCENT%';
    return !inQuotes && /[&|<>()^]/.test(char) ? `^${char}` : char;
  });
}

function killTree(child) {
  if (!WIN) {
    process.kill(-child.pid, 'SIGKILL');
    return;
  }
  const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || 'taskkill failed');
}

function run(cmd, fd, limit) {
  return new Promise((resolve, reject) => {
    const stdio = ['ignore', fd, fd];
    const child = WIN
      ? spawn(cmd.map(quoteWindows).join(' '), { shell: true, stdio, env: { ...process.env, RUN_LONG_PERCENT: '%' } })
      : spawn(cmd[0], cmd.slice(1), { detached: true, stdio });
    const deadline = performance.now() + limit;
    let timer;
    let timedOut = false;
    function checkDeadline() {
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        timer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647));
      } else {
        try {
          killTree(child);
          timedOut = true;
        } catch (error) {
          reject(error);
        }
      }
    }
    child.once('spawn', checkDeadline);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ exit: timedOut ? null : (code ?? 1), timedOut });
    });
  });
}

async function readTail(log, maxLines) {
  const tail = [];
  if (maxLines === 0) return tail;
  const input = fs.createReadStream(log);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (tail.length === maxLines) tail.shift();
    tail.push(`  ${line}`);
  }
  return tail;
}

async function main(argv) {
  const options = parse(argv);
  if (!options) {
    console.error('usage: node run_long.js --log <file> [--minutes N] [--tail N] -- <cmd> [args...]');
    return 2;
  }
  const { log, cmd } = options;
  const done = `${log}.done.json`;
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.rmSync(done, { force: true });
  const fd = fs.openSync(log, 'w');
  const start = performance.now();
  let result;
  try {
    result = await run(cmd, fd, options.minutes * 60_000);
  } finally {
    fs.closeSync(fd);
  }

  const { exit, timedOut } = result;
  const minutes = (performance.now() - start) / 60_000;
  const finishedAt = new Date().toISOString();
  const tail = await readTail(log, options.tail);
  fs.writeFileSync(done, `${JSON.stringify({ cmd, exit, minutes, timedOut, finishedAt })}\n`);
  const status = timedOut ? 'timeout' : `exit=${exit}`;
  console.log([`run_long: ${status} minutes=${minutes.toFixed(1)} log=${log}`, ...tail].join('\n'));
  return timedOut ? 124 : exit;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(`run_long: ${error.message.replace(/[\r\n]+/g, ' ')}`);
  process.exitCode = 1;
});
