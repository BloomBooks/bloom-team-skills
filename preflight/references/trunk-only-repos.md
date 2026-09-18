# Preflight when the code is already on the trunk (no branch, no PR)

Preflight assumes work sits on a branch with a base to diff against. A solo side project can break
that assumption completely — `bloom-table` had 156 commits pushed straight to `master`, no branch,
no PR, and nothing for Devin to review, because Devin reviews a diff against a base and `master`
has no base. ("This project doesn't use a tracker" is the *other* half of that shape, and the
declaration rule in SKILL.md already handles it cleanly.)

The shape that works is a **marker branch**:

1. Keep a long-lived branch (`reviewed`) pointing at the last commit that has been reviewed.
2. Open a draft PR of `master` against `reviewed`, so the PR's diff is exactly the unread code.
3. After the review, advance the marker (`git push --force origin master:reviewed`) and close the
   PR unmerged.

For a backlog that has never been reviewed, **slice it**: four PRs of 2,000–4,500 insertions each
produced real findings where one 12,000-line PR would have been skimmed.

**Do not run the local gate or apply fixes on a slice branch.** This is the sharp edge. A slice is
an old tree: a gate failure there is history, and a fix committed there cannot merge forward. Slice
branches are **review-only** — collect the findings, and land every fix on current `master` as
ordinary work. Skip Phase 1 and Phase 2 on them entirely.

Two mechanics for a repo with no CI: without a `pr-automation.yml` there is nothing to trigger
Devin, and the CI re-run `devin-review` recommends as the reliable trigger doesn't exist either, so
loading the review page in the `devin-noauth` isolated context is the only trigger (it worked first
time on all four slices). *Reading* the result needs no browser at all — both endpoints answer plain
`curl --compressed`.
