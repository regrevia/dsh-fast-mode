#!/usr/bin/env bash
set -u

if [ "$#" -ne 1 ]; then
  printf 'usage: ops.sh DIR\n' >&2
  exit 2
fi

dir=$1
if [ ! -d "$dir" ]; then
  printf 'no such directory: %s\n' "$dir" >&2
  exit 2
fi

total=0
errors=0
status=0
found=0

for file in "$dir"/*.log; do
  [ -f "$file" ] || continue
  found=1
  lines=$(awk 'END { print NR + 0 }' "$file")
  errs=$(awk '/^ERROR/ { n++ } END { print n + 0 }' "$file")
  total=$((total + lines))
  errors=$((errors + errs))
  [ "$errs" -gt 0 ] && status=3
  printf '%s %s %s\n' "$(basename "$file")" "$lines" "$errs"
done

printf 'TOTAL %s %s\n' "$total" "$errors"
exit "$status"
