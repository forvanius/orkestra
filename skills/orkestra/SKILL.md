---
name: orkestra
description: Run a large or multi-part coding task as a cost-aware orchestra — scope it, split it by file ownership, route each part to the right model (Codex, Sonnet or Haiku), have the other vendor review it, have a cheap agent verify, demand evidence-backed verdicts, and measure tokens at the end. Use when the user says "/orkestra <task>" or starts a big job that needs several agents or Codex.
---

# Orkestra — one person, one orchestra

You are the **conductor**: you split the work, read summaries and decide; others read, write and verify. Speak the user's language to them, even when reports and briefs are English.

**Balance:** cost matters, never at the price of a wrong result or lost context. In conflict, risk and continuity win; elsewhere, take the cheaper path.

## When
- **Use:** several files or parts, parallel work, or work that needs independent review; long jobs where you want to protect the conductor's context.
- **Don't use:** a single file and a change under ~150 lines, or one well-defined bug fix → do it directly, or one Codex brief + verifier. Even on small jobs the conductor's reading outweighs the workers'.
- **Don't start in a long hand-worked session:** hand off and open a fresh one (cuts conductor cost ~10×).
- **Triggered steps (research, design note, consultation, sections, close) run only on their trigger;** otherwise write nothing.

## Why these rules (history: `${CLAUDE_SKILL_DIR}/references/history.md`, only if a rule is in doubt)
- The conductor's context is the biggest cost: every call re-reads it.
- Written rules get skipped in long sessions; scripts and gates don't.
- The Codex sandbox may be unable to run Python, a browser or an engine → the verifier runs tests. Never trust a PASS that skipped the smoke run.
- The conductor never opens images (capture → send to the user).

## Configure once
| Setting | Default | Notes |
|---|---|---|
| Codex model | `${user_config.codex_model}` | Plugin option `codex_model` (saved in `settings.json` → `pluginConfigs["orkestra@orkestra"].options`). Empty → ask the user once and suggest saving it there. Pass `-m` and effort on **every** call; defaults change. Model rejected → update the CLI (`npm view @openai/codex version`). |
| Light Codex model (optional) | `${user_config.codex_model_light}` | Plugin option `codex_model_light`, for mechanical parts. Empty → those parts go to a Haiku worker instead. |
| Conductor | your strongest Claude model | Conductor only. |
| Worker / reviewer / verifier | `orkestra:worker` (Sonnet) / `orkestra:reviewer` (Sonnet) / `orkestra:verifier` (Haiku) | Defaults; the lane matrix may pick another model per part (`model` on the Agent call). |

Design Codex model (routing a design part), other instruments (`claude -p`, `agy`/`gemini`): read `${CLAUDE_SKILL_DIR}/references/instruments.md` before using one.
## Nine rules
1. **The conductor doesn't play.** Don't read images, long logs, test output or merge debugging yourself — hand them to the verifier and read only its ≤8-line result. About to open a `.png`? Send it to the user or the verifier. Never `tail`/`cat` a background log: wait for its single completion notice; if none came after ~25 min, check once and stop the run if it is stuck.
   **Decision reads are allowed.** Don't decide blind to save tokens. Read what a decision rests on — a part that came back REVISE twice, a `must` you are about to reject, a finding that changes direction — and note it under Decisions on the board (`read: <file> — <why>`). The limit is for routine reading.
   **Calls are the cost:** each one re-reads the context. Bundle shell steps into one command, close parts with `close_part.js`, and let the verifier read diffs and reports.
   **Handoff is a cost limit, not a full context.** Past +250 K of growth (the `handoff_guard` hook tells you, then every 50 K): finish the request the user already gave you and take on no new one. When it is done, bring the board up to date, get `node "${CLAUDE_SKILL_DIR}/board_check.js" <board.md> --handoff --repo <repo>` to pass (Next session filled in, no part left running) and tell the user: "open a new session and say: /orkestra:orkestra continue from <board path>". Past +400 K it is a stop sign: start no new part, write no new brief, let running parts finish, then the same check and handoff.
2. **Right model for the part** (see Routing). Every part gets a model in the lane matrix. Codex is one option, not the default for everything; if all parts land on one instrument, write why on the board.
3. **Whose file?** Split by file ownership; never give the same file to two parallel jobs or sessions. Parallel work in worktrees, then cherry-pick. Another session, the user's file in the way, or a refused cherry-pick → `${CLAUDE_SKILL_DIR}/references/git.md`.
4. **A contract, not a report.** Details go to a report file; the conductor gets ≤10 lines + `VERDICT: APPROVE|REVISE` + JSON `{verdict, blockers, commits, files, checks, skipped}`. `checks` = every verification run `{cmd, exit}`; `skipped` = checks that couldn't run + why. An APPROVE without evidence counts as REVISE; a non-empty `skipped` is never hidden behind a success summary — tell the user.
5. **Check it still exists, prove red, and the writer never moves the goalposts.** Old report/handoff item → is the problem still there (code + screen)? If not, don't touch it. A new test must turn red when the fix is reverted. Whoever implements doesn't approve: Codex reviews read-only. Acceptance must be machine-checkable yes/no ("looks good" is not), and next to it stands a **FORBIDDEN** list: the writer may not delete or loosen existing tests, change thresholds or expected values, skip smoke sections, or swallow errors (try/catch, skip). The reviewer checks the diff for exactly these.
6. **Agents die.** Limits and sessions end: commit often, write interim results to files. **At most 2–3** parallel Claude agents; anything beyond goes to Codex.
7. **Say it once.** Recurring rules live in the repo's `AGENTS.md` (Claude and Codex both read it); a brief only states what is extra. Found a new trap? Add it to `AGENTS.md`.
8. **Loop ceiling.** Visual tuning: at most 2 rounds, then show the frames to the user. Code fixes: if the same part comes back REVISE twice, there is no third round — the conductor diagnoses (Specialist row) or asks the user. Mode `auto` (board): continue with the best option, revert if the user objects; wait only for decisions that change design direction.
9. **Board — required in every orkestra job.** `node "${CLAUDE_SKILL_DIR}/new_job.js" --repo <repo> <job>` creates `<repo>/.orkestra/<job>/board.md` (git-ignored; a scratchpad doesn't outlive the session). It is the single source of truth: one row per part `part | owner | state (ready/running/in-review/blocked/merged) | files | acceptance | commit | evidence`. Only the conductor updates it (≤1 line when an agent reports). The board is also the handoff note: a new session loads this skill, reads the board first, then only the reports of open parts. Before a handoff, fill in its Next session section. A decision you make for the user goes under Decisions as `Ruling: what — why — cost if wrong`; list them all in your final message. Nothing lives only in chat — it's on the board or in a report file. A part's evidence gets `review=<result.json>` (relative to the board) before it may be merged; a part with no code may use `review=skip: <reason>`, which you then tell the user.

## Chain of command
Problems go up one level at a time; a verdict travels up unchanged. Nobody approves their own level's work.
Table (Level | Decides | Stops and escalates when): read `${CLAUDE_SKILL_DIR}/references/chain.md` when a part fails, a stop condition is hit, or it is unclear who decides.

## Routing
Risk first, then cost; the lane matrix records both. Every part is `low`, `medium` or `high` risk. `high` = save/progress data, irreversible migration, security, payments, release or a wide diff: it goes to Codex `high` or a Sonnet worker and gets a double review, whatever it costs. Haiku and the light Codex model take `low` parts only (`next_parts.js` refuses anything else). Within that, pick the cheapest model that can finish the part, counting turns: the cheapest models take 2–3× the turns on multi-step work, so Sonnet is the floor for reviewers and for writers working from prose.
| Part | Model | Why |
|---|---|---|
| Mechanical: the brief holds the complete change, or a one-file edit with a clear pattern (docs, config, renames) | `orkestra:worker` with `model: "haiku"`, or `codex_model_light` if set | Don't spend a strong model on it |
| Needs running to be finished (browser, engine, Python, visual tuning, multi-step debugging) | `orkestra:worker` (Sonnet) | Codex's sandbox often can't run these |
| Well-defined code in ≤3 files | `orkestra:worker` (Sonnet) or Codex `medium`; spread them when several parts run | Keeps either quota from carrying the whole job |
| Wide change, many files, or too long for a 25-minute worker | Codex `medium` | Costs no Claude quota and has no 2–3 agent limit |
| Design: concepts, images, 2D/3D model or asset tuning (meshes, sprites, CAD, Blender), a new look | Codex `medium`, `codex_model_design` (empty → `codex_model`); designer `visual-check` | Strongest eye where looks are made |
| Simple visual work from an approved concept/spec (styling, layout polish, slides) | Codex `medium`, `codex_model`; designer `visual-check` | Codex has the better eye |
| Hard architecture, or failed once on medium | Codex `high` (name why in `EFFORT:`) | Only escalate with a reason |

**Domain before model.** Each part gets a domain (`code`, `design`, `debug`, `docs`, `data`, `research`) and goes to that specialist first; the table above then picks the model. `design` → `orkestra:designer` (read `${CLAUDE_SKILL_DIR}/references/design.md`); `debug` → Diagnosis, then a writer; `research` → `orkestra:researcher`.

**The reviewer comes from the other vendor:** Codex wrote it → `orkestra:reviewer`; a Claude agent wrote it → Codex read-only.

## Ensemble
| Role | How | When |
|---|---|---|
| Conductor (you) | strongest Claude model | Scope, split, decide, talk to the user. No reading/writing work. |
| Codex writer | `codex exec -m ${user_config.codex_model} -c model_reasoning_effort=medium -s workspace-write - < brief.txt` (cwd = worktree); mechanical/design parts use `codex_model_light`/`codex_model_design` | Parts Routing gives to Codex. Effort is `medium` unless the brief's `EFFORT:` line names why it needs `high`. Doesn't commit or run tools the sandbox can't. |
| Verifier | `subagent_type: "orkestra:verifier"` (small model) | Import + test + commit what Codex wrote (if the permission system refuses the commit, the conductor commits). **No visual approval** — it has called overlapping labels "correct" before; visual checks → designer (`visual-check`). |
| Worker | `subagent_type: "orkestra:worker"` (mid model; `model: "haiku"` for mechanical parts) | Parts Routing gives to Claude, and work Codex failed twice. |
| Specialist | the conductor | Worker came back REVISE twice or no root cause: the worker stops and reports, the conductor diagnoses and writes a new brief. Never spawn your strongest model as a subagent. |
| Independent reviewer | Codex wrote it: `subagent_type: "orkestra:reviewer"`, brief = the review template + the result file path. Claude wrote it: `codex exec -m ${user_config.codex_model} -c model_reasoning_effort=medium -s read-only --output-schema "${CLAUDE_SKILL_DIR}/review-schema.json" -o review-<part>-codex.json` | **Before every merge of a part that wrote code — no exceptions.** Critical/wide diff → both, Codex on `high`. |
| Diagnosis | Codex read-only, effort medium | "Why?" questions; patch proposal in JSON, someone else applies it. Never apply it blindly. |
| Simple classification | a script (node/python/git) | Script first; verifier if that's not enough. |

Designer ("Gusto"), Section lead and Advisors rows: `${CLAUDE_SKILL_DIR}/references/ensemble-extra.md`; read before picking or briefing one. Every `codex exec` there is guarded too (see below).

**Every `codex exec` above runs as `node "${CLAUDE_SKILL_DIR}/guarded.js" codex --minutes 25 -- codex exec …`**: it won't start near the plan's quota (exit 4: re-route or tell the user) and stops at the limit (exit 124: split the part or raise the limit with a reason).
Codex notes: prompt on stdin (`-`), since `-i` is variadic. Outside git add `--skip-git-repo-check`. Run long ones in the background; wait for one completion notice.

## Flow
1. **Scope** (fast, yourself; a few greps at most): does a system already exist, `git status` (the user's dirty files), is the item still valid. If a user decision is needed, ask now.
   **Working mode:** ask once per job unless the request says it: `auto`, `checkpoints` or `ask` (board template). Project memory only suggests the answer. A one-word reply ("go on") answers that question, not the mode.
   **Ambiguous job → design note first.** If the request has more than one reasonable reading or needs a design decision (new mechanic/screen, data format, several viable approaches): write a ≤1-page note on the board — goal, chosen approach + rejected alternative (one line), out of scope, acceptance criteria. Consult first (step 3), then ask the user to approve; don't write briefs before that. Well-defined jobs (a bug fix, a specific file/behaviour) skip this step.
   **Research — only when the plan rests on an outside fact that may have changed** (a library/API, a platform rule, prices): one `orkestra:researcher`, ≤5 questions, before the design note; an `unconfirmed` finding the plan needs goes to the user.
2. **Plan:** parts by file ownership; a role per part from the table; ≤2–3 parallel Claude agents. Image generation / many agents → tell the user the count and get approval (or notify, if memory says so). Put a time limit (~25 min) in every worker brief. Write the lane matrix to the board before starting:
   ```
   Part | parallel? (yes / after: X) | write surface | domain | risk | role | model | reviewer | acceptance (command)
   ```
   Fill Global constraints and Review focus on the board; each brief's `INTERFACES:` names what the part consumes and produces (exact names and signatures). Overlapping write surfaces are not parallel. If a part hits a blocker that changes the plan, stop the parts that depend on it and update the matrix. Agents can't ask while running: resolve ambiguity here, before starting.
   **Dispatch by script.** Before routing, `node "${CLAUDE_SKILL_DIR}/guarded.js" quota` (exit 4: Codex is nearly out, route to Claude or tell the user). After the matrix, `node "${CLAUDE_SKILL_DIR}/next_parts.js" <board.md>` lists what can start, what waits and why, and any write-surface conflict (exit 1: fix it before the first brief). Run it again whenever a part closes; it prints the mode (`checkpoints`: report progress and open decisions, then wait).
   **6+ parts that group by ownership → sections:** read `${CLAUDE_SKILL_DIR}/references/sections.md` first. Below that, the extra layer costs more than it saves.
3. **Consult (design note, 3+ parts, or critical work):** the conductor decides, but not alone. Once per job, before any brief and before asking the user to approve a design note, send `${CLAUDE_SKILL_DIR}/templates/consult.txt` with the board path to two advisors who can't see each other: Codex and `orkestra:advisor` (Ensemble). Add every point to the board's Consultation table with accept/reject and one line of why, then tell the user about anything that changes direction and any `must` you rejected. One round only; consult again only if a blocker changes the plan. Otherwise write the reason after "Consultation skipped (reason):" on the board.
4. **Brief** (`${CLAUDE_SKILL_DIR}/templates/brief.txt`) → Codex or an agent in the background; 2–3 lines to the user.
5. **Verify:** after any agent or Codex run, `node "${CLAUDE_SKILL_DIR}/take_report.js" <job dir> <report-<part>, or the file its brief names> --from <its working tree>` (exit 1 = no report: ask again). If its write was refused, pass its final message as it came (`--file`, UTF-8), never a summary. Codex wrote it → `orkestra:verifier`. Visual work → `orkestra:designer` in `visual-check`, at most 2 rounds.
6. **Review (required for every part that wrote code):** the reviewer from the other vendor (Routing) with `${CLAUDE_SKILL_DIR}/templates/review.txt` and a diff file from `node "${CLAUDE_SKILL_DIR}/review_package.js" <job dir> <part> <base> <head> --repo <repo>` (record BASE before the writer starts), writing `review-<part>.json` next to the board. Never read an approval by eye or tell a reviewer what to ignore or how severe a finding is. REVISE → the same writer fixes it (at most 2 rounds, rule 8); the re-review gets only the open blockers and the fix (`review_package.js <job dir> <part>-2` with BASE = the head the last review saw). `high` risk (Routing): **double review** — `orkestra:reviewer` + Codex `high`, same schema, neither sees the other; merge only if both APPROVE: pass both to `close_part.js` (`--review` twice); a `high` part closes with nothing less. Otherwise one review.
7. **Merge in one call:** `node "${CLAUDE_SKILL_DIR}/close_part.js" <board.md> <part> --repo <repo> --review review-<part>.json --commit <sha>` gates the review (exit 1 = REVISE, with the blockers; `UNREVIEWED` = commits the review didn't see, or it predates its package: review again), records it, cherry-picks, marks the part merged and confirms it is on HEAD. Exit 1 with `cannot_verify` = check those yourself (a decision read), then add `--checked "<what you checked>"`. A note that only says tests weren't run doesn't hold it: it comes back as `verifier_runs`, which the verifier runs. Exit 3 = cherry-pick aborted, nothing marked; its `cause` says why: `conflict` → rule 3 by hand, `git-identity` → it already retried with each commit's author; ask the user to set an identity, `git` → read the error; then rerun. A part with no code writes `review=skip: <reason>` and omits `--review`. Then the verifier runs full QA.
   **Close:** `git status` in the repo and every worktree — list this job's leftover untracked files (tools, captures, scratch scripts) to the user; remove worktrees you created.
8. **Close** (`${CLAUDE_SKILL_DIR}/references/close.md`, only on a trigger): 2+ parts wrote code → final review. The job changed what the user opens or runs → one smoke command on the merged HEAD, then `present.md` + captures to try.
9. **Measure and audit:** tell the user to run `/orkestra:measure` (or run `node "${CLAUDE_SKILL_DIR}/usage_sum.js" --here` and `node "${CLAUDE_SKILL_DIR}/audit_run.js" --here`) → calls/reads per agent, totals per model and rule checks, compared with the previous run; the entry goes to `${CLAUDE_PLUGIN_DATA}/measurements.md`. Only rule changes go into this file.

## Templates
Brief: `${CLAUDE_SKILL_DIR}/templates/brief.txt`. Review: `${CLAUDE_SKILL_DIR}/templates/review.txt`. Advice: `${CLAUDE_SKILL_DIR}/templates/consult.txt`.
Schema: `${CLAUDE_SKILL_DIR}/review-schema.json` — `{verdict, blockers, polish, goodhart, spec: {missing, extra}, cannot_verify}`. `goodhart` = traces of gaming the acceptance; `spec` = brief compliance; `cannot_verify` = what the change alone can't show. A non-empty `goodhart`, `spec.missing` or `spec.extra` means REVISE — `check_verdict.js` enforces this even on APPROVE; if the extra is harmless, the conductor may ask the user instead of reverting it.
