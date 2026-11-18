# Instruments: swapping the writer and the reviewer

Orkestra routes each part to a model (the Routing table in the skill) and has the other vendor review it: `orkestra:reviewer` for Codex-written code, Codex read-only for Claude-written code. Any CLI agent can take the writer or reviewer role if it has:

1. **A non-interactive mode** — runs a prompt and exits.
2. **A write mode limited to the working directory** (writer) and **a read-only mode** (reviewer).
3. **Machine-readable output** — a JSON schema flag, or at least JSON output that `check_verdict.js` can parse.
4. **Model and effort flags** you can pass on every call.

Whatever the instrument, run its review output through the gate:
```bash
node "<skill-dir>/check_verdict.js" result.json   # exit 0 APPROVE · 1 REVISE · 2 no valid verdict
```
The gate enforces the schema and forces REVISE when `goodhart` or `spec` is non-empty, so a lenient reviewer can't wave a change through.

## Status of each recipe
| Instrument | Writer | Reviewer | Structured output | Verified by us |
|---|---|---|---|---|
| Codex CLI | `-s workspace-write` | `-s read-only` | `--output-schema` (enforced) | **yes** — the measured runs |
| Claude Code (`claude -p`) | `--permission-mode acceptEdits` + `--allowedTools` | `--permission-mode plan` | `--json-schema` | flags checked against `claude --help` (2.1.200); a live call not yet run |
| Antigravity CLI (`agy`) | not tried | `--mode plan` | `--json-schema` (file path) + `--output-format json` → `structured_output` | **run on 2026-11-13 (1.5.7, free tier, Gemini 3.8 Flash): not usable as a reviewer yet** — see below |
| Gemini CLI | `--approval-mode auto_edit` (+ `--sandbox`) | `--approval-mode plan` | none — JSON in `response`, parsed by the gate | from the official docs (0.66); not run. Reported replaced by `agy` for consumer accounts (unconfirmed) |

Please open an issue with a working (or failing) run for the unverified rows.

## Codex CLI (default)
```bash
# writer (cwd = the part's worktree)
codex exec -m <CODEX_MODEL> -c model_reasoning_effort=medium -s workspace-write - < brief.txt
# reviewer
codex exec -m <CODEX_MODEL> -c model_reasoning_effort=medium -s read-only \
  --output-schema "<skill-dir>/review-schema.json" -o result.json - < review.txt
```
Notes: prompt on stdin (`-i` is variadic); `--skip-git-repo-check` outside a repo; `-C <dir>` sets the working directory. The sandbox may be unable to run Python, a browser or your engine — the verifier runs tests.

## Claude Code as an instrument (`claude -p`)
Inside a Claude Code conductor, prefer the plugin's subagents (`orkestra:worker`, `orkestra:verifier`) — they share your session's auth and show up in `usage_sum.js`. `claude -p` is for the other cases: **the conductor is another tool** (Codex, Gemini, Hermes…), you want a **hard spending cap** per job, or a separate account.
```bash
# writer (run in the worktree)
claude -p --model sonnet --permission-mode acceptEdits \
  --allowedTools "Read Grep Glob Edit Write" --max-budget-usd 2 < brief.txt
# reviewer: plan mode never edits; git read commands only
claude -p --model sonnet --permission-mode plan \
  --allowedTools "Read Grep Glob Bash(git show *) Bash(git diff *) Bash(git log *)" \
  --json-schema "$(cat "<skill-dir>/review-schema.json")" --output-format json \
  --max-budget-usd 1 < review.txt > result.json
node "<skill-dir>/check_verdict.js" result.json
```
Notes: `--max-budget-usd` stops the run at a dollar cap; `--effort low|medium|high|xhigh|max` sets effort. Headless `claude -p` needs its own login (`claude` → `/login`, or an API key); a desktop-app session is not enough. To run tests, allow them explicitly, e.g. `Bash(npm test *)`.

## Antigravity CLI (`agy`)
Google's terminal agent. Install: `winget install --id Google.AntigravityCLI --exact` (Windows; a native binary, no Node), then run `agy` once to log in. `agy models` lists what the account can use: the free tier had Gemini 3.8 Flash only, no Gemini 4.
```bash
# reviewer: plan mode did not touch files; the schema is a file path
agy -p "Review as instructed in review.txt. Read files with your file-reading tool; run no shell commands." \
  --mode plan --model <GEMINI_MODEL> --output-format json \
  --json-schema "<skill-dir>/review-schema.json" --print-timeout 300s > result.json
node "<skill-dir>/check_verdict.js" result.json
```
What one session of runs showed (1.5.7, free tier, 2026-11-13):
- **Works:** `-p` runs once and exits; `--json-schema` returns a conforming object in `structured_output`, which the gate reads; on an 18-line file with three planted bugs it found all three, correct lines, in 101 s and ~55 K tokens.
- **Trap — an empty answer that says SUCCESS:** headless mode cannot prompt for the shell permission, so a run that wanted a shell command returned `"status":"SUCCESS"` with an empty `response` and a `denied_actions` list. The gate rejects it (exit 2: no verdict), so never read the status field instead. Telling it to use the file-reading tool only fixed that run.
- **Fails on real code:** three reviews of 2–5 files of this repo (36–135 lines each) hit `--print-timeout` after 5–7 minutes with no answer, inside the repo and in an isolated copy. The event stream (`--output-format stream-json`) of a one-file run showed it ignoring the scope in the prompt: it read seven other files and guessed test paths until the time ran out. Whether the model or the CLI is at fault was not separated, and Gemini 4 models were not tried.
- **Privacy:** the files it reads go to Google. On the free tier the published terms do not clearly say whether they are used for training, and telemetry is on by default — don't point it at a client's code.

Until a run on real code returns a verdict, keep it out of the lane matrix.

## Gemini CLI
Not run by us, and reported replaced by `agy` for consumer accounts (unconfirmed): check that `gemini --version` works before relying on this section.
Install: `npm i -g @google/gemini-cli`, then run `gemini` once to log in. Set the plugin option `gemini_model` (or leave it empty for Gemini CLI's default); the skill shows the conductor that option's value, and the conductor uses the commands below.
```bash
# writer: edits auto-approved, shell commands still need your policy; --sandbox needs Docker/Podman (macOS: Seatbelt)
gemini -m <GEMINI_MODEL> --approval-mode auto_edit --sandbox -o json \
  -p "Follow the brief on stdin. Reply with the OUTPUT block it asks for." < brief.txt > writer.json
# reviewer: plan mode is read-only
gemini -m <GEMINI_MODEL> --approval-mode plan -o json \
  -p "Review as instructed on stdin. End your reply with ONLY a JSON object matching review-schema.json." \
  < review.txt > result.json
node "<skill-dir>/check_verdict.js" result.json
```
Notes: `-p` text is appended to stdin. JSON output is `{response, stats, error?}`; exit codes `0` ok, `1` error, `42` bad input, `53` turn limit. There is no schema flag, which is why the gate matters most here.

## Mixing instruments
A reviewer from a **different vendor than the writer** catches more than a same-model review, because the two don't share blind spots. Useful pairings:
- Codex writes → Claude (`claude -p` plan mode) reviews. A Google model as a third opinion is the idea, not yet a working recipe (see Antigravity CLI).
- Claude writes → Codex reviews (the default reviewer).
- Critical work (rule: double review): two reviewers from two vendors, same schema, neither sees the other; merge only if the gate passes both.

## Windows
Windows PowerShell 5.1 strips the double quotes inside arguments passed to native programs, so an inline JSON schema arrives broken (`--json-schema is not valid JSON`). Pass schemas and prompts through files or stdin, or run the commands from Git Bash / PowerShell 7.
