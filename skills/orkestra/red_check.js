#!/usr/bin/env node
// Orkestra red check: proves a new test catches the bug. It runs the test with the fix (must pass), puts the
// fix files back to BASE, runs it again (must fail), and then restores the files exactly as they were,
// uncommitted edits included. It replaces `git checkout -- <file>` / `git stash` in someone's working tree,
// which loses work when it goes wrong, and it runs in place, so the project's installed dependencies,
// build output and local config are all there (a fresh checkout would fail for the wrong reason).
//
//   node red_check.js --base <sha> --revert <file>[,<file>...] [--repo <dir>] -- "<test command>"
//   node red_check.js --restore [--repo <dir>]      put files back after a check that was killed midway
//
// --revert  the files that hold the fix (not the test). A file that did not exist at BASE is removed for
//           the red run and put back afterwards. BASE versions are read the way checkout writes them
//           (line endings, filters), so a CRLF project is not red for the wrong reason.
// Before changing anything it saves the files and a manifest under the repo's git folder; a killed run
// leaves them there, and the next run refuses until --restore puts them back.
// The red run must fail a check, not crash: a new ReferenceError, TypeError, missing module and the like
// (one the green run doesn't show) is refused, unless the output also shows a failed assertion (unittest's
// FAIL + traceback, pytest's `E assert`, node:test's `not ok` are checks, not crashes). --expect "<text>": the red output must contain this text
// (the failing assertion's message); use it when the bug itself is such an error.
// Known limit: a test killed from outside on Windows exits like a failing test, so it would read as red;
// don't run it under a timeout that kills it.
// Prints {green, red, restored}. Exit: 0 = green with the fix and red without it, 1 = not green with the
// fix, still green without it, the red run did not finish, or the test changed other files; 2 = bad input
// or an interrupted earlier check.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const { git } = require('./board_check.js');

const run = (cmd, cwd) => {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim(), tail = out.split('\n').slice(-5).join(' / ');
  return { exit: r.status, signal: r.signal, error: r.error && r.error.message, tail, out };
};

// A red run that crashed (the test's own code or harness broke) proves nothing about the bug: it would be red
// for any reason. Markers that also show in the green run are noise (a logged warning), so only new ones count.
const CRASH = /\b(?:ReferenceError|TypeError|SyntaxError|RangeError|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|ImportError|NameError|AttributeError|IndentationError)\b|Cannot find module|is not defined\b|is not a function\b|Cannot read propert(?:y|ies) of (?:undefined|null)|Traceback \(most recent call last\)|panicked at/g;
// A failed check is proof even when the runner also prints a traceback for it (Python's unittest prints
// "Traceback" for every FAIL; pytest and node:test print stacks too): such output is not a crash.
const FAILED_CHECK = /\bAssertionError\b|^FAIL: |^FAILED\b.*\bfailures=|^E\s+assert\b|^not ok\b|\bassert(?:ion)? failed\b/m;
const crashes = (red, green) => {
  if (FAILED_CHECK.test(red)) return [];
  const seen = new Set(green.match(CRASH) || []);
  return [...new Set(red.match(CRASH) || [])].filter(m => !seen.has(m));
};

// What a run did to tracked files, so a test that rewrites fixtures is caught instead of trusted: the
// status lines plus a hash of the tracked diff (a file already modified can change and keep its status).
const status = top => {
  const d = spawnSync('git', ['-C', top, 'diff', 'HEAD', '--binary'], { maxBuffer: 1024 * 1024 * 1024 });
  return git(top, ['status', '--porcelain', '--untracked-files=no']).stdout + require('crypto').createHash('sha256').update(d.stdout || '').digest('hex');
};

function stash(top) { return path.join(git(top, ['rev-parse', '--absolute-git-dir']).stdout.trim(), 'orkestra-red-check'); }

function restore(top) {
  const dir = stash(top), manifest = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifest)) return { code: 0, out: { ok: true, restored: 0 } };
  const saved = JSON.parse(fs.readFileSync(manifest, 'utf8')), failed = [];
  for (const s of saved) {
    try { if (s.had) fs.copyFileSync(path.join(dir, s.copy), s.abs); else if (fs.existsSync(s.abs)) fs.unlinkSync(s.abs); }
    catch (e) { failed.push(`${s.abs}: ${e.message}`); }
  }
  if (failed.length) return { code: 1, out: { ok: false, restored: false, errors: [`could not restore: ${failed.join('; ')}; copies stay in ${dir}`] } };
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: 0, out: { ok: true, restored: saved.length } };
}

function redCheck({ repo = process.cwd(), base, files, cmd, expect = null }) {
  if (!base || !files || !files.length || !cmd) return { code: 2, out: { ok: false, errors: ['need --base, --revert and a test command after --'] } };
  const topR = git(repo, ['rev-parse', '--show-toplevel']);
  if (topR.status !== 0) return { code: 2, out: { ok: false, errors: [`not a git repo: ${repo}`] } };
  const top = topR.stdout.trim();
  if (fs.existsSync(stash(top))) return { code: 2, out: { ok: false, errors: [`another red check is running here, or an earlier one was interrupted: if none is running, run node red_check.js --restore --repo ${top}`] } };
  if (git(top, ['cat-file', '-e', base + '^{commit}']).status !== 0) return { code: 2, out: { ok: false, errors: [`commit ${base} not found`] } };
  const realTop = fs.realpathSync(top), plan = [];
  for (const f of files) {
    const abs = path.resolve(top, f), rel = path.relative(top, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { code: 2, out: { ok: false, errors: [`${f} is outside the repo`] } };
    // The nearest existing folder above it, resolved: a symlinked or junctioned folder must not lead out.
    let up = path.dirname(abs); while (!fs.existsSync(up)) up = path.dirname(up);
    const realUp = path.relative(realTop, fs.realpathSync(up));
    if (realUp.startsWith('..') || path.isAbsolute(realUp)) return { code: 2, out: { ok: false, errors: [`${f} sits under a link that leads outside the repo`] } };
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (st && !st.isFile()) return { code: 2, out: { ok: false, errors: [`${f} is not a regular file (a symlink or folder): red_check handles files only`] } };
    // Is it in BASE? ls-tree answers yes, no, or fails; only a clean "no" means the file is new with the fix.
    const posix = rel.replace(/\\/g, '/'), listed = git(top, ['ls-tree', '--name-only', base, '--', posix]);
    if (listed.status !== 0) return { code: 2, out: { ok: false, errors: [`could not list ${posix} in ${base}: ${listed.stderr.trim()}`] } };
    const spec = `${base}:${posix}`, atBase = listed.stdout.trim() !== '';
    let old = null;
    if (atBase) {
      // --filters: the bytes checkout would write (eol, smudge), read as a buffer so binary files survive.
      const r = spawnSync('git', ['-C', top, 'cat-file', '--filters', spec], { maxBuffer: 1024 * 1024 * 1024 });
      if (r.status !== 0 || r.error) return { code: 2, out: { ok: false, errors: [`could not read ${spec}: ${r.error ? r.error.message : String(r.stderr).trim()}`] } };
      old = r.stdout;
    }
    plan.push({ abs, had: !!st, old });
  }

  const clean = status(top), green = run(cmd, top);
  if (green.exit !== 0) return { code: 1, out: { ok: false, green: false, errors: [`the test fails WITH the fix (${green.signal ? 'killed by ' + green.signal : 'exit ' + green.exit}): ${green.error || green.tail}`] } };

  // Save first, with a manifest, so a killed run can be undone by --restore. Creating the folder is the
  // lock: a second check started meanwhile fails here instead of overwriting this one's copies.
  const dir = stash(top);
  try { fs.mkdirSync(dir); } catch { return { code: 2, out: { ok: false, errors: [`another red check started here meanwhile; run one at a time`] } }; }
  const saved = plan.map((p, i) => ({ abs: p.abs, had: p.had, copy: String(i) }));
  plan.forEach((p, i) => { if (p.had) fs.copyFileSync(p.abs, path.join(dir, String(i))); });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(saved));
  let red;
  try {
    for (const p of plan) {
      if (p.old) { fs.mkdirSync(path.dirname(p.abs), { recursive: true }); fs.writeFileSync(p.abs, p.old); }
      else if (p.had) fs.unlinkSync(p.abs);
    }
    red = run(cmd, top);
  } finally {
    var back = restore(top);
  }
  if (back.code) return back;
  const changed = status(top) !== clean;
  if (changed) return { code: 1, out: { ok: false, restored: true, errors: [`the test changed tracked files outside --revert (git status differs): check them before trusting either run`] } };
  if (red.exit == null) return { code: 1, out: { ok: false, green: true, restored: true, errors: [`the red run did not finish (${red.signal || red.error}): no proof either way`] } };
  if (red.exit === 0) return { code: 1, out: { ok: false, green: true, red: false, restored: true, errors: ['the test still passes with the fix reverted: it does not catch the bug'] } };
  if (expect && !red.out.includes(expect)) return { code: 1, out: { ok: false, green: true, red: true, restored: true, red_exit: red.exit, errors: [`the red run failed, but not with "${expect}": it failed for another reason (${red.tail})`] } };
  const crash = expect ? [] : crashes(red.out, green.out);
  if (crash.length) return { code: 1, out: { ok: false, green: true, red: true, restored: true, red_exit: red.exit, crash, errors: [`the red run crashed (${crash.join(', ')}) instead of failing a check: no proof the test catches the bug. Fix the test so it fails an assertion, or pass --expect "<the assertion's message>" if this error is the bug itself (${red.tail})`] } };
  return { code: 0, out: { ok: true, green: true, red: true, restored: true, red_exit: red.exit, ...(expect ? { expect } : {}) } };
}

if (require.main === module) {
  const a = process.argv.slice(2), dash = a.indexOf('--');
  const opts = dash >= 0 ? a.slice(0, dash) : a, words = dash >= 0 ? a.slice(dash + 1) : [];
  // One quoted string after `--`: several words have lost their quotes in the shell that ran us, and no
  // re-quoting is right on every OS (cmd expands %VAR%, backslashes differ), so it is refused instead.
  if (words.length > 1) { console.error('pass the test command as ONE quoted string after --, e.g. -- "npm test -- reader"'); process.exit(2); }
  const cmd = words[0] || '';
  const flag = k => { const i = opts.indexOf(k); return i >= 0 ? opts.splice(i, 1) && true : false; };
  const take = k => { const i = opts.indexOf(k); return i >= 0 ? opts.splice(i, 2)[1] : null; };
  const doRestore = flag('--restore'), repo = take('--repo') || process.cwd(), base = take('--base'), revert = take('--revert'), expect = take('--expect');
  if (opts.length) { console.error('usage: node red_check.js --base <sha> --revert <file>[,<file>...] [--repo <dir>] [--expect "<text>"] -- "<test command>"\n       node red_check.js --restore [--repo <dir>]'); process.exit(2); }
  let r;
  if (doRestore) {
    const top = git(repo, ['rev-parse', '--show-toplevel']);
    r = top.status ? { code: 2, out: { ok: false, errors: [`not a git repo: ${repo}`] } } : restore(top.stdout.trim());
  } else r = redCheck({ repo, base, files: (revert || '').split(',').map(s => s.trim()).filter(Boolean), cmd, expect });
  console.log(JSON.stringify(r.out));
  process.exit(r.code);
}

module.exports = { redCheck, restore };
