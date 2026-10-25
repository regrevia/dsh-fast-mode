#!/usr/bin/env bash
# Aggregate an access log into out/report.tsv and out/bad_lines.txt.
set -u

log=""
if [ "$#" -ge 1 ]; then
  log="$1"
elif [ -f access.log ]; then
  log="access.log"
elif [ -f seed/access.log ]; then
  log="seed/access.log"
fi

if [ -z "$log" ] || [ ! -f "$log" ]; then
  echo "error: log not found: ${log:-access.log}" >&2
  exit 1
fi

mkdir -p out

exec python3 - "$log" <<'PY'
import re
import sys

SHAPE = re.compile(
    r'^(\S+) - - \[([^\]]+)\] "([^"]*)" (\S+) (\S+) (\S+)(?: (.*))?$')
STATUS = re.compile(r'^[0-9]{3}$')
DIGITS = re.compile(r'^[0-9]+$')
SEG = re.compile(r'^[0-9]+$')

REASONS = ("bad_format", "bad_status", "bad_duration")


def parse(line):
    m = SHAPE.match(line)
    if not m:
        return None, "bad_format"
    request = m.group(3)
    status = m.group(4)
    size = m.group(5)
    duration = m.group(6)
    parts = request.split(" ")
    if len(parts) != 3 or any(p == "" for p in parts):
        return None, "bad_format"
    if not STATUS.match(status):
        return None, "bad_status"
    if size != "-" and not DIGITS.match(size):
        return None, "bad_format"
    if not DIGITS.match(duration):
        return None, "bad_duration"
    return (parts[1], int(status), int(duration)), None


def group(path):
    path = path.split("?", 1)[0]
    out = []
    for seg in path.split("/"):
        out.append(":id" if SEG.match(seg) else seg)
    return "/".join(out)


def bucket(status):
    return "%dxx" % (status // 100) if status // 100 in (2, 3, 4, 5) else "other"


def main(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    counts = {}
    durations = {}
    bad = []
    for lineno, line in enumerate(lines, start=1):
        if line.endswith("\r"):
            line = line[:-1]
        parsed, reason = parse(line)
        if reason is not None:
            bad.append("%d: %s" % (lineno, reason))
            continue
        key = (bucket(parsed[1]), group(parsed[0]))
        counts[key] = counts.get(key, 0) + 1
        durations.setdefault(key, []).append(parsed[2])
    rows = ["status_bucket\tpath_group\tcount\tp95_ms"]
    for key in sorted(counts):
        vals = sorted(durations[key])
        rank = (95 * len(vals) + 99) // 100
        rows.append("%s\t%s\t%d\t%d" % (key[0], key[1], counts[key],
                                        vals[rank - 1]))
    with open("out/report.tsv", "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(rows) + "\n")
    with open("out/bad_lines.txt", "w", encoding="utf-8", newline="") as f:
        f.write("".join(line + "\n" for line in bad))
    return 0


sys.exit(main(sys.argv[1]))
PY
