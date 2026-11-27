# Example run

An **illustrative** walk-through on a small web app, showing what each step produces. The artifacts
are the real formats of the current version; the numbers are examples, not measurements — real ones
are in [measurements.md](measurements.md). `<skill>` stands for the skill directory and `<job>` for
`.orkestra/offline/`.

## 0. Request
```
/orkestra add offline reading: cache the last 20 chapters and show them without network
```

## 1. Scope (conductor, a few greps)
- `git status`: the user has an uncommitted `src/reader/view.ts` → it goes on DO NOT TOUCH for every brief.
- There is already a `storage.ts` helper wrapping IndexedDB → reuse it.
- Asked once: working mode → `checkpoints`; real-world test → "on my phone, flight mode".
- "Offline reading" has two readings (cache on open vs. explicit download) → **design note** first.
- Discovery: the plan adds no library or service, it reuses `storage.ts` → `Discovery: skipped — no outside dependency, reuses storage.ts`. Had it needed, say, a service-worker library, a researcher would have listed the candidates with release dates, licences and fit before the design note.

`node <skill>/new_job.js --repo . offline` creates `<job>/board.md` from the template.

## 2. Design note on the board
```markdown
## Working mode
- Mode: checkpoints

## Design note
- Goal: chapters opened online are readable offline; at most 20, oldest evicted first.
- Chosen approach: cache on open via storage.ts.   Rejected alternative: explicit "download" button (new UI, out of scope).
- Out of scope: images over 5 MB, sync across devices.
- Acceptance (machine-checkable): `npm test -- offline` → 0 failed; `npm run e2e -- offline.spec` → 0 failed.
- Approved by user: no

## Real-world test
- Where/how: user's phone, flight mode, open a cached chapter
```

## 3. Lane matrix and parts
```markdown
| Part | parallel? (yes / after: X) | write surface | domain | risk | role | model | reviewer | acceptance (command) |
|---|---|---|---|---|---|---|---|---|
| A | yes | src/offline/cache.ts, test/offline.test.ts | code | medium | Codex writer | codex_model | orkestra:reviewer | npm test -- offline |
| B | after: A | src/reader/load.ts, e2e/offline.spec.ts | code | low | Codex writer | codex_model | orkestra:reviewer | npm run e2e -- offline.spec |
```
A and B touch different files, but B needs A's API, so B waits. `node <skill>/guarded.js quota`
passes, and `node <skill>/next_parts.js <job>/board.md` lists `start: [A]`, `waiting: [B]`.

## 4. Consult, then approval
Two parts and a design note → the consult template goes to Codex and `orkestra:advisor`, neither
sees the other. Codex: `should — B's e2e needs the service worker registered in test mode —
e2e/setup.ts:12` → accepted, written in the Consultation table. The user then approves the design
note (`Approved by user: yes`).

## 5. Brief for part A (from `templates/brief.txt`)
```
TASK: add a chapter cache (max 20, LRU) on top of src/storage.ts
CONTEXT: the board: .orkestra/offline/board.md
YOUR FILES: src/offline/cache.ts, test/offline.test.ts
DO NOT TOUCH: src/reader/view.ts (user's uncommitted work)
INTERFACES: consumes storage.get/put(key, value); produces cache.open(id) → Chapter, cache.list() → id[]
ACCEPTANCE: npm test -- offline → 0 failed
EFFORT: medium
FORBIDDEN: deleting or loosening existing tests, changing thresholds or expected values, skipping sections, swallowing errors
VERIFY: the eviction test is red when the LRU line is reverted (red_check.js)
TIME LIMIT: 25 min
OUTPUT: .orkestra/offline/report-A.txt; ≤10 lines + VERDICT + JSON
CONSTRAINTS CHECKLIST: ...   RUN ENVIRONMENT: ... (copied from AGENTS.md)
```
```bash
node <skill>/guarded.js codex --minutes 25 -- \
  codex exec -m <CODEX_MODEL> -c model_reasoning_effort=medium -s workspace-write -C ../wt-a - < brief-a.txt
```

## 6. Report and verifier
`node <skill>/take_report.js <job> report-A.txt --from ../wt-a` copies the report next to the board.
Codex wrote it, so the verifier (`orkestra:verifier`) runs the acceptance outside the sandbox:
```
npm test -- offline: 7 passed. red_check.js with cache.ts reverted → "evicts the oldest" failed (red proven).
{"verdict":"APPROVE","blockers":[],"commits":["a1b2c3d"],"files":["src/offline/cache.ts","test/offline.test.ts"],"checks":[{"cmd":"npm test -- offline","exit":0},{"cmd":"red_check.js … npm test -- offline","exit":0}],"skipped":[]}
VERDICT: APPROVE
```

## 7. Independent review and the gate
Codex wrote A, so the other vendor reviews it:
```bash
node <skill>/review_package.js <job> A <base> a1b2c3d --repo .
```
`orkestra:reviewer` gets the review template plus the package and writes `<job>/review-A.json`.
It wrote APPROVE but listed something in `spec.extra`; the close gate turns that into REVISE:
```bash
node <skill>/close_part.js <job>/board.md A --repo . --review review-A.json --commit a1b2c3d
```
```json
{"ok":false,"part":"A","verdict":"REVISE","forced_by":["spec.extra"],"blockers":[],"goodhart":[],
 "spec":{"missing":[],"extra":["cache size is configurable via a new settings option — not requested"]},
 "hint":"only spec.extra forced this: revert the extra, or keep it with --accept-extra \"<reason>\" and tell the user"}
```
In `checkpoints` the user decides: remove it → one Codex fix round, package `A-2`, re-review →
`APPROVE`, and the same `close_part.js` call (with both commits) merges A and writes
`review=review-A.json` into the evidence.

## 8. Part B, close
Part B follows the same loop. Two parts wrote code → a `final` part with one integration review.
The job changed what the user opens → the verifier runs the Close smoke on the merged HEAD and writes
`present.md`; the conductor shows the Try-note ("flight mode, open chapter 3, report what you see").

## 9. Board at the end
```markdown
| Part | owner | state (ready/running/in-review/blocked/merged) | files | acceptance | commit | evidence |
|---|---|---|---|---|---|---|
| A | Codex | merged | cache.ts, offline.test.ts | npm test -- offline | a1b2c3d e7f8a9b | 7 passed; red proven; review=review-A.json |
| B | Codex | merged | load.ts, offline.spec.ts | npm run e2e -- offline.spec | d4e5f6a | 3 passed; review=review-B.json |
| final | Claude | merged | none | integration review | none | review=skip: review-final.json APPROVE, no code |
```

## 10. Measure
```
node <skill>/usage_sum.js --here --budget .orkestra/offline/board.md
node <skill>/audit_run.js --here        # or /orkestra:measure
```
Summary to the user: Claude reads and conductor share against the board's Budget estimate; Codex
2 writes + 1 fix + 3 reviews; the review caught one unrequested option. Appended to the plugin's
measurement log.
