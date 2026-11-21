#!/usr/bin/env node
// Orkestra report taker. Every agent, Claude or Codex, writes its report inside its OWN working tree at
// .orkestra/<job>/<name>.txt: that is the one place each of them can always write (a Codex sandbox and an
// isolated worktree both include their own tree, and .orkestra/ is git-ignored in every worktree of the
// repo). An agent working in the conductor's checkout writes straight into the job folder. This copies the
// report into the job folder without the conductor reading it, and fails when an agent said it wrote a
// report that is not there.
//
//   node take_report.js <job dir> <name> [--from <the agent's working tree>]
//   node take_report.js <job dir> <name> --file <final message saved as UTF-8>   (or --stdin from bash)
//
// <name> can include .txt or .md to select that file. A bare name selects the newest report and
// defaults to .md when saving a final message.
// --stdin is for an agent whose own write was refused (a harness rule, a sandbox): it put the whole report
// in its final message, which is already in the conductor's context, so saving it costs nothing extra. The
// conductor pipes that message in VERBATIM; the file is marked as saved from the final message. Writing a
// summary instead is still forbidden: a too-short text is refused.
// Prints {ok, report} or {ok:false, errors}. Exit: 0 = the report is in the job folder, 1 = no report
// where the agent was told to write it, 2 = bad input.
const fs = require('fs'), path = require('path');
const reportExtension = /\.(md|txt)$/i;

function takeReport(jobDir, name, from = null) {
  name = String(name || '');
  const explicit = reportExtension.test(name);
  if (from === '') return { code: 2, out: { ok: false, errors: ["--from needs the agent's working tree"] } };
  if (!/^[\w.-]+$/.test(name.replace(reportExtension, ''))) return { code: 2, out: { ok: false, errors: [`bad report name: ${name}`] } };
  if (!jobDir || !fs.existsSync(jobDir)) return { code: 2, out: { ok: false, errors: [`job folder not found: ${jobDir}`] } };
  const slash = p => p.replace(/\\/g, '/');
  const candidates = explicit ? [name] : [name + '.md', name + '.txt'];
  const pick = dir => {
    let newest;
    let newestMtime = -Infinity;
    for (const candidate of candidates) {
      const file = path.join(dir, candidate);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.mtimeMs > newestMtime) {
        newest = file;
        newestMtime = stat.mtimeMs;
      }
    }
    return newest;
  };
  if (!from) {
    // Only for an agent that worked in the conductor's own checkout: the job folder is its tree.
    const t = pick(jobDir);
    return t ? { code: 0, out: { ok: true, report: slash(t), copied: false } }
      : { code: 1, out: { ok: false, errors: [`no ${candidates.join(' or ')} in ${slash(jobDir)}; if the agent worked in its own tree, pass --from <that tree>`] } };
  }
  // With --from the agent's tree decides, every round: an older copy in the job folder never stands in
  // for a report this round did not write.
  const srcDir = path.join(from, '.orkestra', path.basename(path.resolve(jobDir)));
  const source = pick(srcDir);
  if (!source) return { code: 1, out: { ok: false, errors: [`no report at ${slash(path.join(srcDir, candidates[0]))}${explicit ? '' : ' or .txt'}: the agent did not write it — ask for it again, don't write it from its summary`] } };
  const target = path.join(jobDir, path.basename(source));
  if (path.resolve(source) === path.resolve(target)) return { code: 0, out: { ok: true, report: slash(target), copied: false } };
  fs.copyFileSync(source, target);
  return { code: 0, out: { ok: true, report: slash(target), copied: true, from: slash(source) } };
}

if (require.main === module) {
  const a = process.argv.slice(2), s = a.indexOf('--stdin'), stdin = s >= 0 && a.splice(s, 1).length > 0;
  const take = k => { const i = a.indexOf(k); return i >= 0 ? (a.splice(i, 2)[1] || '') : null; };
  const from = take('--from'), file = take('--file');   // --file: the message saved as UTF-8 (a PowerShell 5.1 pipe mangles non-ASCII)
  if (a.length !== 2 || [stdin || null, from, file].filter(x => x !== null).length > 1 || file === '') { console.error('usage: node take_report.js <job dir> <name> [--from <agent working tree> | --file <final message, UTF-8> | --stdin < final-message]'); process.exit(2); }
  const r = stdin || file ? saveFinalMessage(a[0], a[1], fs.readFileSync(file || 0, 'utf8')) : takeReport(a[0], a[1], from);
  console.log(JSON.stringify(r.out));
  process.exit(r.code);
}

function saveFinalMessage(jobDir, name, text) {
  const requested = String(name || '');
  name = requested.replace(reportExtension, '');
  if (!/^[\w.-]+$/.test(name)) return { code: 2, out: { ok: false, errors: [`bad report name: ${name}`] } };
  if (!jobDir || !fs.existsSync(jobDir)) return { code: 2, out: { ok: false, errors: [`job folder not found: ${jobDir}`] } };
  const body = String(text || '').trim();
  // A report carries the contract (VERDICT + JSON); a few lines without it are a summary, not the report.
  if (body.length < 200 || !/^VERDICT:\s*(APPROVE|REVISE)\s*$/m.test(body)) return { code: 1, out: { ok: false, errors: ['this is not the agent\'s full final message (no VERDICT line, or under 200 characters): paste the message as it came, or ask the agent for it again'] } };
  const filename = name === requested ? name + '.md' : requested;
  const target = path.join(jobDir, filename);
  if (fs.existsSync(target)) return { code: 1, out: { ok: false, errors: [`${filename} already exists in the job folder: a new round gets a new name (${name}-2)`] } };
  fs.writeFileSync(target, `<!-- saved by the conductor from the agent's final message; the agent's own write was refused -->\n${body}\n`);
  return { code: 0, out: { ok: true, report: target.replace(/\\/g, '/'), from_message: true } };
}

module.exports = { takeReport, saveFinalMessage };
