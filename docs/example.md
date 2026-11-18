# Example run

An **illustrative** walk-through on a small web app, showing what each step produces. The artifacts
are the real formats; the numbers are examples, not measurements — real ones are in
[measurements.md](measurements.md).

## 0. Request
```
/orkestra add offline reading: cache the last 20 chapters and show them without network
```

## 1. Scope (conductor, a few greps)
- `git status`: the user has an uncommitted `src/reader/view.ts` → it goes on DO NOT TOUCH for every brief.
- There is already a `storage.ts` helper wrapping IndexedDB → reuse it.
- "Offline reading" has two readings (cache on open vs. explicit download) → **design note** first.

## 2. Design note on the board — user approves
```markdown
## Design note
- Goal: chapters opened online are readable offline; at most 20, oldest evicted first.
- Chosen approach: cache on open via storage.ts.   Rejected: explicit "download" button (new UI, out of scope).
- Out of scope: images over 5 MB, sync across devices.
- Acceptance: `npm test -- offline` → 0 failed; `npm run e2e -- offline.spec` → 0 failed.
- Approved by user: yes
```

## 3. Lane matrix and parts
```markdown
| Part | parallel? | write surface | risk | role | acceptance (command) |
|---|---|---|---|---|---|
| A cache | yes | src/offline/cache.ts, test/offline.test.ts | eviction order | Codex writer | npm test -- offline |
| B wiring | after: A | src/reader/load.ts, e2e/offline.spec.ts | user's dirty view.ts nearby | Codex writer | npm run e2e -- offline.spec |
```
A and B touch different files, but B needs A's API, so B waits.

## 4. Brief for part A (from `templates/brief.txt`)
```
TASK: add a chapter cache (max 20, LRU) on top of src/storage.ts
YOUR FILES: src/offline/cache.ts, test/offline.test.ts
DO NOT TOUCH: src/reader/view.ts (user's uncommitted work)
ACCEPTANCE: npm test -- offline → 0 failed
FORBIDDEN: deleting/loosening existing tests, changing expected values, swallowing errors
VERIFY: the eviction test is red when the LRU line is reverted
TIME LIMIT: 25 min
```
```bash
codex exec -m <CODEX_MODEL> -c model_reasoning_effort=medium -s workspace-write -C ../wt-a - < brief-a.txt
```

## 5. Verifier (orkestra:verifier) runs the acceptance
```
npm test -- offline: 7 passed. Reverted the LRU line → "evicts the oldest" failed (red proven).
{"verdict":"APPROVE","checks":[{"cmd":"npm test -- offline","exit":0},{"cmd":"npm test -- offline (LRU reverted)","exit":1}],"skipped":[],"blockers":[]}
VERDICT: APPROVE
```

## 6. Independent review (Codex read-only) and the gate
```bash
codex exec -m <CODEX_MODEL> -c model_reasoning_effort=medium -s read-only \
  --output-schema review-schema.json -o result.json - < review-a.txt
node check_verdict.js result.json
```
The reviewer wrote APPROVE but listed something in `spec.extra`:
```json
{"valid":true,"verdict":"REVISE","stated":"APPROVE","forced_by":["spec.extra"],
 "blockers":[],"goodhart":[],"spec":{"missing":[],"extra":["cache size is configurable via a new settings option — not requested"]},"polish":[]}
```
Exit code 1 → REVISE. The extra option is harmless, so the conductor asks the user: *keep it or remove it?* The user says remove → one fix round to the same writer → review again → `APPROVE`, exit 0.

## 7. Part B, merge, QA
Part B follows the same loop. Cherry-pick both parts; `view.ts` (the user's dirty file) is protected with the rule-3 patch dance. The verifier runs the full QA quietly.

## 8. Board at the end
```markdown
| Part | owner | state | files | acceptance | commit | evidence |
|---|---|---|---|---|---|---|
| A cache | Codex | merged | cache.ts, offline.test.ts | npm test -- offline | a1b2c3d | 7 passed; red when LRU reverted |
| B wiring | Codex | merged | load.ts, offline.spec.ts | npm run e2e -- offline.spec | d4e5f6a | 3 passed |
```

## 9. Measure
```
/orkestra:measure
```
```
3f9a1c22 MAIN (conductor)          claude-opus-…   calls   18 cacheR    1.90M ...
3f9a1c22 verify part A             claude-haiku-…  calls    5 cacheR    0.31M ...
3f9a1c22 verify part B             claude-haiku-…  calls    6 cacheR    0.36M ...
TOTAL calls 29 cacheR 2.57M ...
```
Summary to the user: 29 Claude calls, 2.6 M reads, conductor 74 %; Codex 2 writes + 3 reviews; the review caught one unrequested option. Appended to the plugin's measurement log.
