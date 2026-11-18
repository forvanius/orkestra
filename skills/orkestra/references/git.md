# Git traps — read when a merge meets the user's uncommitted file, a cherry-pick refuses, or you start another session

- **Another session in the same checkout:** a session you start (or suggest) that will write code gets its own worktree, or waits until the other writer has committed. Two sessions editing one folder overwrite each other with nothing to stop it. Seen in a pilot job: the title job opened a background-scene session in the same folder, both headed for `index.html`, and the title build had to be held back by hand. A read-only or concept-only session may share the folder.

- **User's uncommitted file in the way:** `git diff f > patch`, `git checkout -- f`, cherry-pick, `git apply --3way patch`, `git restore --staged f` (merge both sides on conflict).
- **Generated noise:** don't let worktrees commit engine-generated metadata. If cherry-pick says "untracked would be overwritten", use `git format-patch | git am --3way --exclude=<generated-glob>`.
