#!/usr/bin/env node
// Orkestra report taker. Every agent, Claude or Codex, writes its report inside its OWN working tree at
// .orkestra/<job>/<name>.md: that is the one place each of them can always write (a Codex sandbox and an
// isolated worktree both include their own tree, and .orkestra/ is git-ignored in every worktree of the
// repo). An agent working in the conductor's checkout writes straight into the job folder. This copies the
// report into the job folder without the conductor reading it, and fails when an agent said it wrote a
// report that is not there.
//
//   node take_report.js <job dir> <name> [--from <the agent's working tree>]
//
// <name> is the file name without .md: report-A, verify-A, ...
// Prints {ok, report} or {ok:false, errors}. Exit: 0 = the report is in the job folder, 1 = no report
// where the agent was told to write it, 2 = bad input.
const fs = require('fs'), path = require('path');

function takeReport(jobDir, name, from = null) {
  name = String(name || '').replace(/\.md$/i, '');   // "research" and "research.md" name the same file
  if (from === '') return { code: 2, out: { ok: false, errors: ['--from needs the agent\'s working tree'] } };
  if (!/^[\w.-]+$/.test(name)) return { code: 2, out: { ok: false, errors: [`bad report name: ${name}`] } };
  if (!jobDir || !fs.existsSync(jobDir)) return { code: 2, out: { ok: false, errors: [`job folder not found: ${jobDir}`] } };
  const target = path.join(jobDir, name + '.md');
  const slash = p => p.replace(/\\/g, '/'), isFile = p => fs.statSync(p, { throwIfNoEntry: false })?.isFile();
  if (!from) {
    // Only for an agent that worked in the conductor's own checkout: the job folder is its tree.
    return isFile(target) ? { code: 0, out: { ok: true, report: slash(target), copied: false } }
      : { code: 1, out: { ok: false, errors: [`no ${name}.md in ${slash(jobDir)}; if the agent worked in its own tree, pass --from <that tree>`] } };
  }
  // With --from the agent's tree decides, every round: an older copy in the job folder never stands in
  // for a report this round did not write.
  const source = path.join(from, '.orkestra', path.basename(path.resolve(jobDir)), name + '.md');
  if (!isFile(source)) return { code: 1, out: { ok: false, errors: [`no report at ${slash(source)}: the agent did not write it — ask for it again, don't write it from its summary`] } };
  if (path.resolve(source) === path.resolve(target)) return { code: 0, out: { ok: true, report: slash(target), copied: false } };
  fs.copyFileSync(source, target);
  return { code: 0, out: { ok: true, report: slash(target), copied: true, from: slash(source) } };
}

if (require.main === module) {
  const a = process.argv.slice(2), i = a.indexOf('--from'), from = i >= 0 ? (a.splice(i, 2)[1] || '') : null;
  if (a.length !== 2) { console.error('usage: node take_report.js <job dir> <name> [--from <agent working tree>]'); process.exit(2); }
  const r = takeReport(a[0], a[1], from);
  console.log(JSON.stringify(r.out));
  process.exit(r.code);
}

module.exports = { takeReport };
