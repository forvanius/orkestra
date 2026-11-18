# Section leads

For jobs of 6+ parts that group by ownership.

Below that, the extra layer costs more than it saves. Give each `orkestra:section-lead` one worktree, its parts' tasks, acceptance and FORBIDDEN lists, the two `guarded.js` commands, a report file and a 60-minute limit; at most 2 sections at once. Parts that Routing gives to Claude stay with the conductor. When a section comes back: one `orkestra:reviewer` over all its commits, then `close_part.js` for each part chained with `&&` in one call, every part using that one review file. A section lead's APPROVE is never the review.

Review and close a section's parts one at a time, as for any part: `review_package.js` per part (its own BASE..HEAD), one `review-<part>.json` each, then `close_part.js`. `close_part.js` merges exactly the commits a review saw, so one review over the whole section can't close its parts separately.
