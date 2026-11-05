#!/usr/bin/env bash
# Usage: carry-downloads.sh <release tag> <file name> <count from before this existed>
# Prints how often <file name> of a rolling release has been downloaded over all its builds.
# GitHub resets a file's download count whenever the file is replaced, which every build does. So each
# build writes the running total into its release notes (an HTML comment the website reads), and the
# next build adds the replaced file's own count to it before deleting the old release.
set -u
tag="$1"; file="$2"; seed="${3:-0}"
# the REST API, like the website (`gh release view --json` would call the count downloadCount)
filter='((((.body // "") | capture("muriel-downloads-before: (?<n>[0-9]+)") | .n | tonumber)) // $seed)
  + ([.assets[] | select(.name == $file) | (.downloadCount // .download_count // 0)] | add // 0)'
total="$(gh api "repos/${GITHUB_REPOSITORY:-cloverscripts/riff-muriel}/releases/tags/$tag" 2>/dev/null | jq -r --arg file "$file" --argjson seed "$seed" "$filter" 2>/dev/null || true)"
case "$total" in ''|*[!0-9]*) total="$seed" ;; esac
echo "carry-downloads: $tag $file: $total so far" >&2
echo "$total"
