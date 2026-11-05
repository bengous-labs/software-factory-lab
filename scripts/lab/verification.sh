#!/bin/sh
# Prints, for each commit of `<branch>` newer than `<since>`, one line read from GitHub's API:
# short SHA, parent count, committer, verified and its reason, subject. The record the spec asks
# for on the merge queue test.
#   scripts/lab/verification.sh <since-sha> [branch]
set -eu
repo=bengous-labs/software-factory-lab
since=$1
branch=${2:-dev}
gh api "repos/$repo/compare/$since...$branch" --paginate --jq '.commits[].sha' | while read -r sha; do
  gh api "repos/$repo/commits/$sha" --jq '[
    .sha[0:7],
    (.parents | length | tostring) + " parent(s)",
    .commit.committer.name,
    (.commit.verification.verified | tostring),
    .commit.verification.reason,
    (.commit.message | split("\n")[0])
  ] | join(" | ")'
done
