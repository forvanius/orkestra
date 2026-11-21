# AGENTS.md

Rules for agents (Claude, Codex) working in this repo, the orkestra Claude Code plugin.
A brief states only what is extra; these hold for every job.

## Tests

- Run all tests: `node --test tests/*.test.js`. Expect 0 failed before you commit.
- `skills/orkestra/SKILL.md` must stay under 20000 bytes. `tests/job_tools.test.js`
  ("every skill stays under the size that survives compaction") enforces it for every skill.
  Move sometimes-needed text to `skills/orkestra/references/` instead of trimming rules.
- Never delete or loosen tests, thresholds or expected values.

## Code

- Scripts under `skills/` and `hooks/` are plain Node with no dependencies.
  Do not add packages or a package.json; use Node built-ins only.
- LF line endings everywhere (`.gitattributes`: `* text=auto eol=lf`). Tests measure
  file sizes in bytes, so a CRLF checkout changes results. Check: `git ls-files --eol <file>`.

## Git traps

- A checkout may have no git identity. For commits and cherry-picks pass the identity
  through the environment: `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
  `GIT_COMMITTER_EMAIL`. Changing git config is the user's decision, not an agent's.
  `close_part.js` already picks each commit with its own author as the committer when no
  identity is configured; exit 3 with cause `git-identity` means even that failed.
- Prove a test is red with `skills/orkestra/red_check.js`, never with `git checkout --`,
  `git stash` or `git reset` in a working tree.
- Pass a comma-separated file list to `red_check.js --revert`.
- Claude Code subagents cannot write report-like `.md` files. Use `.txt` reports.

## Run environment

- Use Node (`node`) from the checkout root and run `node --test tests/*.test.js`.
- On Windows the scripts and tests may use Git Bash. Quote paths with spaces and preserve backslashes.

## Review paths

- In `review=` evidence, `review=a.json+b.json` is the two-review form (two distinct reviews, required for high-risk parts).
- Keep `+` out of review file names and folder names. Do not depend on how a single
  path containing `+` is read; rename it.
