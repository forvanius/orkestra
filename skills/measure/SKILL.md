---
name: measure
description: Measure and audit an orkestra run — calls and cache reads per agent and model, the conductor's share, timing, and rule checks (model/effort routing, review gating, parallelism, secrets), compared with your previous run. Run it after an orkestra job.
argument-hint: "[--last N] | [<project-transcript-dir> <session-id> ...]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/orkestra/usage_sum.js *) Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/orkestra/audit_run.js *)
---

# Measure and audit an orkestra run

Both scripts only read transcripts; they change nothing.

1. Run the meter and the auditor with the same arguments. Arguments: `$ARGUMENTS`
   - No arguments → `--here` (newest session of the current folder); `--last N` → `--here --last N`; a transcript directory and session ids → pass them through.
   - `node ${CLAUDE_PLUGIN_ROOT}/skills/orkestra/usage_sum.js <args>`
   - `node ${CLAUDE_PLUGIN_ROOT}/skills/orkestra/audit_run.js <args>` (exit 1 = at least one FAIL)
   If either reports no transcripts, say so and stop — don't guess paths.
2. Summarize in ≤8 lines: total calls and cache reads, the conductor's share (%) and max context, wall clock; Codex calls by role with model and effort; then every **FAIL**, then the WARNs that matter. Cache reads dominate cost — lead with them.
3. Report Codex's tokens, models and quota from the auditor's "Codex's own files" line, and say it covers every Codex run on this machine in the run's time window. If that line is missing, say Codex tokens were not measured.
4. Compare with the last entry of `${CLAUDE_PLUGIN_DATA}/measurements.md` if it exists: conductor share, total reads, wall clock, number of FAILs — up or down.
5. Append one entry to `${CLAUDE_PLUGIN_DATA}/measurements.md` (create the file if missing):
   `- <date> <job>: <calls> calls, <reads> reads, conductor <x>%, <min> min; Codex <writes>/<reviews>, <tokens>; FAIL <n>, WARN <n>; real bugs found by review: <n>; lesson: <one line>`
   Show the user the line you appended. If a lesson or a repeated FAIL suggests a rule change, propose it — don't edit the orkestra skill yourself.
