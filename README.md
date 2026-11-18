# Orkestra

**Run big coding jobs in Claude Code as a team instead of one long chat — with a second AI checking every change before it lands.**

[Türkçe](README.tr.md) · MIT · experimental (`0.6.0`)

You give Claude Code one task. Orkestra turns it into a small crew: a **conductor** that plans and decides, **writers** that each own their own files, a **reviewer from a different AI vendor** that hunts for bugs, and a cheap **verifier** that actually runs the tests. Nothing is merged on someone's word — every "done" has to come with the commands that prove it, and a script, not a model, decides whether a change may land.

```text
/orkestra:orkestra add offline caching to the reader and cover it with tests
```

## Who it is for

- You use **Claude Code** and your jobs are getting big: several files, several steps, work that runs past one session.
- You want **another vendor's model** (OpenAI's Codex by default) to review what Claude writes, and Claude to review what Codex writes.
- You care what it costs. In long jobs the most expensive thing is the conductor re-reading everything it has seen; Orkestra keeps it out of the reading and writing.

**Not for:** a one-file fix or a change under ~150 lines. Orkestra says so itself and does those directly.

## How a job flows

```mermaid
flowchart LR
    U([You: one task]) --> C[Conductor<br/>scopes, splits, decides]
    C --> B[(Board<br/>parts · owners · evidence)]
    C -->|brief| W1[Writer A<br/>Codex]
    C -->|brief| W2[Writer B<br/>Claude worker]
    W1 --> V[Verifier<br/>runs the tests]
    W2 --> V
    V --> R{Reviewer from<br/>the other vendor}
    R -->|REVISE| W1
    R -->|APPROVE| G[close_part.js<br/>gate + merge]
    G --> B
    G --> M([Merged, measured,<br/>ready to try])
```

1. **Scope.** The conductor checks what already exists and asks you only what changes the direction.
2. **Split.** The job becomes parts on a board (`.orkestra/<job>/board.md`, git-ignored). Each part owns its files, so parallel writers never touch the same file.
3. **Write.** Each part goes to the cheapest instrument that can finish it: Codex for wide or visual work, a Claude worker for code that must be run to be finished, Haiku for mechanical edits.
4. **Verify.** A small model runs the acceptance command. A writer can't approve its own work.
5. **Review.** The other vendor reviews the exact commits that will be merged, from a diff file, and returns a fixed JSON verdict.
6. **Merge.** `close_part.js` merges only if the review passed **and** covers exactly those commits; a high-risk part needs two independent reviews.
7. **Measure.** `/orkestra:measure` shows what each agent cost and checks the run against the rules.

## Quick start

**1. Install the plugin**
```bash
claude plugin marketplace add forvanius/orkestra
claude plugin install orkestra@orkestra
```

**2. Install and log in to Codex** (the default second vendor)
```bash
npm i -g @openai/codex
codex login
```
Keep it up to date: an old Codex CLI rejects new models with "model is not supported". No Codex? Claude Code itself (`claude -p`) can be the second writer and reviewer — see [docs/instruments.md](docs/instruments.md).

**3. Pick your Codex model.** Claude Code asks for it when the plugin is enabled (change it later in `/config`).

**4. Run a job** in your project:
```text
/orkestra:orkestra <what you want done>
```

**5. Measure it** when it's done:
```text
/orkestra:measure
```

Requirements: [Claude Code](https://code.claude.com), Node.js, git. Developed and piloted on Windows; the CI runs the test suite on Windows, macOS and Linux.

## What you get at the end

- **Merged commits** on your branch, each part reviewed by the other vendor and verified by a test run.
- **A board** that records every part, who wrote it, its review and its evidence — and doubles as the handoff note if the job spans sessions.
- **A short report** for anything you can open or run: how to open it, what to try, what is unfinished, with desktop and mobile captures.
- **A cost table**: calls and token reads per agent and model, compared with your previous run.

What a part's evidence looks like on the board:
```text
| A | codex | merged | src/reader.js, tests/reader.test.js | npm test -- reader | 3f9c2a1 | review=review-A.json |
```

## Why you can trust a "done"

- **Evidence, not reports.** Every agent returns a verdict plus the commands it ran and their exit codes. An approval without evidence counts as a rejection.
- **No moving the goalposts.** Each brief forbids deleting or loosening tests, changing thresholds or swallowing errors; the reviewer checks the diff for exactly that.
- **Proof the test catches the bug.** `red_check.js` runs the new test with the fix (must pass) and without it (must fail), then restores your files exactly.
- **Reviews bound to commits.** A commit added after the review can't ride on its approval.
- **Your work is safe.** No destructive git in your working tree; the merge refuses to run while you are in the middle of your own merge or cherry-pick.

## Settings

| Option | What it does |
|---|---|
| `codex_model` | Model for every `codex exec` call (writing, reviewing). |
| `codex_model_design` | Optional stronger model for design: concepts, images, 2D/3D asset tuning. |
| `codex_model_light` | Optional cheaper Codex model for mechanical parts (else a Haiku worker). |
| `gemini_model` | Only if you add Google's CLI as a writer or reviewer. |

Set them in `/config` or in `settings.json` under `pluginConfigs["orkestra@orkestra"].options`. Put recurring project rules in your repo's `AGENTS.md`: Claude agents and Codex both read it, so briefs stay short.

## FAQ

**Does it save money?** In our runs the same scale of work cost about **15× fewer Claude cache-read tokens** than an all-Claude orchestration, and Codex reviews found real bugs in 9 of 13 rounds. That counts Claude tokens only; Codex runs on its own plan. Details: [docs/measurements.md](docs/measurements.md).

**What if Codex hits its limit?** `guarded.js` checks your Codex quota before every run. Near the limit it stops and the conductor asks you: wait, or route the part to Claude.

**Can I stop and continue tomorrow?** Yes. The board is the handoff note; a new session reads it and picks up the open parts. A hook tells the conductor when its context has grown enough that a fresh session would be cheaper.

**Which languages?** The skill is written in English; the conductor talks to you in your language. Boards may use English or Turkish headers.

## More

- [docs/example.md](docs/example.md) — a full job, step by step
- [docs/instruments.md](docs/instruments.md) — Codex, Claude Code headless and Gemini/Antigravity recipes
- [docs/measurements.md](docs/measurements.md) — the runs behind the rules
- [skills/orkestra/SKILL.md](skills/orkestra/SKILL.md) — the conductor's rules

## Status and known limits

`0.6.0`, experimental. Measured on game and web projects; the merge path ran in five pilot jobs, one of them on an unrelated project. Numbers from your runs are the most useful contribution.

- `close_part.js` merges only commits packaged by `review_package.js`; a review written by hand, or named other than `review-<name>.json`, is refused.
- `red_check.js` can't tell a test killed from outside on Windows from a failing one; don't run it under a timeout that kills the test.

## License

[MIT](LICENSE)
