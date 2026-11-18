#!/usr/bin/env node
// Orkestra job folder: <repo>/.orkestra/<job>/ with the board in it. It lives in the repo because a
// handoff depends on it and a session's scratchpad doesn't outlive the session. Git-ignored through
// .git/info/exclude, so the user's .gitignore stays untouched. (`git clean -fdx` would delete it.)
//
//   node new_job.js --repo <dir> <job>
//
// An existing board is never overwritten. Prints {dir, board}. Exit: 0 = ok, 2 = bad input.
const fs = require('fs'), path = require('path');
const { git } = require('./board_check.js');

function newJob(repo, job) {
  if (!/^[\w.-]+$/.test(job || '') || /^\.+$/.test(job)) return { code: 2, out: { errors: [`bad job name: ${job} (letters, digits, . _ - only)`] } };
  const common = git(repo, ['rev-parse', '--git-common-dir']);
  if (common.status !== 0) return { code: 2, out: { errors: [`not a git repo: ${repo}`] } };
  const top = git(repo, ['rev-parse', '--show-toplevel']).stdout.trim();
  const dir = path.join(top, '.orkestra', job), board = path.join(dir, 'board.md');
  fs.mkdirSync(dir, { recursive: true });
  const created = !fs.existsSync(board);
  if (created) fs.writeFileSync(board, fs.readFileSync(path.join(__dirname, 'templates', 'board.md'), 'utf8').replace('<job>', job));
  const exclude = path.join(path.resolve(repo, common.stdout.trim()), 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!/^\.orkestra\/?\s*$/m.test(text)) fs.writeFileSync(exclude, text + (text && !text.endsWith('\n') ? '\n' : '') + '.orkestra/\n');
  return { code: 0, out: { dir: dir.replace(/\\/g, '/'), board: board.replace(/\\/g, '/'), created } };
}

if (require.main === module) {
  const a = process.argv.slice(2), i = a.indexOf('--repo'), repo = i >= 0 ? a.splice(i, 2)[1] : process.cwd();
  if (a.length !== 1) { console.error('usage: node new_job.js --repo <dir> <job>'); process.exit(2); }
  const r = newJob(repo, a[0]);
  console.log(JSON.stringify(r.out));
  process.exit(r.code);
}

module.exports = { newJob };
