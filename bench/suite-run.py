#!/usr/bin/env python3
"""Deterministic long-task suite runner.

For every (task, pair, arm) it copies the fixture seed into a clean run directory,
runs one DSH turn with an arm patch, then grades the artifact with the fixture's
hidden unittest file. One JSON row per run, appended to
``bench/results/suite-<tag>.jsonl`` so an interrupted block can be resumed: rows
already present for (task, pair, arm) are skipped.

Usage:
  python3 bench/suite-run.py --tasks codeimpl,shellops --arms off,def15 --pairs 6 --tag TA1
  python3 bench/suite-run.py --tasks ledger --arms off,fl10,open15 --pairs 12 --tag TA3   # resumes

Pair ``p`` runs its arms in forward order when p is odd and in reverse order when p
is even (ABBA), which cancels slow drift in machine load across a block.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_EXE = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
DEFAULT_CLI = ('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/'
               'node_modules/@deepseek-ai/dsh/lib/bin.js')
DEFAULT_MET = pathlib.Path.home() / '.dsh/fast-mode-metrics.jsonl'
TOKEN_TIMEOUT = 1500
# Run directories live OUTSIDE the repo on purpose. Inside bench/.runs the
# fixtures were two levels up (../../suite/<task>/hidden, .../ref), and runs that
# explored upward could read the hidden test or the reference solution — which
# both invalidates the grade and adds a large, arm-dependent wall-clock swing.
# The root must also be free of a SECOND copy of the fixtures. A stale mirror at
# /tmp/fm-bench/suite was reachable from a /tmp run directory by listing the
# parent, and one run read its hidden test there (caught by the canary below).
# runs now live under the OS temp root and every copy of bench/suite outside the
# repo is removed, so listing the parent yields nothing but sibling run dirs.
# That still leaves the repo itself readable, and a W5 run walked from its temp
# cwd to ~/Desktop/DSH, grepped the fixture text and read both the hidden test
# and the reference. So a block now preloads every task (prompt, test module,
# seed path) and then chmods hidden/ and ref/ to 000 for the duration; verify()
# grades from memory, and the tree is restored on exit or on a signal.
DEFAULT_RUNS = pathlib.Path(os.environ.get('TMPDIR', '/tmp')) / 'dsh-runs'
SESSIONS = pathlib.Path.home() / '.dsh' / 'sessions'
LEAK_MARKERS = ('/hidden/', '/ref/', 'bench/suite/', 'fm-bench/suite', 'MANIFEST.json')


def session_dir(dest):
    """The per-cwd session store the harness writes for a run directory."""
    # macOS resolves /tmp to /private/tmp; the store keys on the real path.
    real = os.path.realpath(str(dest)).lstrip('/').replace('/', '-')
    return SESSIONS / ('--' + real + '--')


def session_ids(dest):
    d = session_dir(dest)
    if not d.is_dir():
        return set()
    # metrics rows carry the full directory name, including the prefix
    return {p.name for p in d.iterdir()
            if p.is_dir() and p.name.startswith('session-')}


NODE = shutil.which('node') or 'node'
# One debug line per delivered reminder (index.js writes it at the step boundary).
DEBUG_LINE = re.compile(r'step=(\d+).*?turnSteps=(\d+).*?directive=([a-z-]+)')
# The resolved fields that decide which reminders an arm can emit. Copied from
# bench/arm-config.mjs POLICY_KEYS so a row is self-describing without the YAML.
POLICY_KEYS = ('enabled', 'gear', 'scheduler', 'guidance', 'lateDiscipline', 'discipline',
               'disciplineAfterSteps', 'disciplineRepeatAtSteps', 'disciplineEarlyCalls',
               'rereadHint', 'openBatch', 'preferPatch', 'batchVerify', 'shapeGate',
               'stepBudget', 'finishLineSteps', 'outputBudget', 'outputBudgetAfterSteps',
               'parallel', 'fanoutWidth', 'workspaceMap', 'stallGuard', 'toolTimeoutMs',
               'shellParallel', 'reassertAfterCompaction', 'lazy', 'lazyEffort',
               'lazyVariant')


def resolve_arm(arm_path):
    """The config the plugin runs with, from its own resolveConfig."""
    try:
        p = subprocess.run([NODE, str(HERE / 'arm-config.mjs'), str(arm_path), '--json'],
                           capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            print(f'warning: arm-config failed for {arm_path}: {p.stderr.strip()[:200]}',
                  file=sys.stderr)
            return None
        return json.loads(p.stdout).get('resolved')
    except Exception as exc:  # noqa: BLE001 - metadata must never fail a paid run
        print(f'warning: arm-config unavailable ({exc})', file=sys.stderr)
        return None


def arm_summary(resolved):
    """The reminder-relevant subset of a resolved config, or None."""
    return None if not resolved else {k: resolved.get(k) for k in POLICY_KEYS}


INLINE_CONFIG = re.compile(r'^(\s*)config:\s*\{(.*)\}\s*$')


def _split_flow(body):
    """Split a YAML flow mapping body on top-level commas."""
    parts, depth, cur = [], 0, ''
    for ch in body:
        if ch in '[{':
            depth += 1
        elif ch in ']}':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur.strip())
            cur = ''
            continue
        cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return parts


def observed_arm(arm_path, dbg):
    """Arm patch plus `debug: true` / `debugFile`, so reminders are recorded.

    `debug` only writes the step-boundary line `index.js` already formats; it
    changes no scheduling decision and adds no request. The file lives outside the
    run directory so `leak_scan` never reads it.

    Some arms write `config: {enabled: false}` on one line; appending indented keys
    after a flow mapping would be invalid YAML, so those are expanded to block form
    first (keys only, values kept verbatim).
    """
    lines = []
    for ln in arm_path.read_text().splitlines():
        if re.match(r'\s+(debug|debugFile):', ln):
            continue
        m = INLINE_CONFIG.match(ln)
        if m:
            indent, body = m.group(1), m.group(2)
            lines.append(f'{indent}config:')
            lines += [f'{indent}  {kv}' for kv in _split_flow(body)]
        else:
            lines.append(ln)
    return '\n'.join(lines).rstrip('\n') + '\n' + \
        f'    debug: true\n    debugFile: {json.dumps(str(dbg))}\n'


def reminder_events(dbg):
    """Delivered reminders as `[{step, turnStep, kind}]`, one per debug line."""
    if not dbg.exists():
        return []
    events = []
    for line in dbg.read_text(errors='replace').splitlines():
        m = DEBUG_LINE.search(line)
        if m:
            events.append({'step': int(m.group(1)), 'turnStep': int(m.group(2)),
                           'kind': m.group(3)})
    return events


def leak_scan(dest):
    """True when a run's transcript reached the fixture (hidden test or ref)."""
    d = session_dir(dest)
    if not d.is_dir():
        return False
    for f in d.glob('*/session.v4.jsonl.zstd'):
        try:
            raw = subprocess.run(['zstd', '-dc', str(f)], capture_output=True, timeout=120).stdout
        except Exception:  # noqa: BLE001 - a missing zstd must not fail the block
            return False
        text = raw.decode('utf-8', 'replace')
        if any(m in text for m in LEAK_MARKERS):
            return True
    return False


def suite_digest(suite):
    files = {str(p.relative_to(HERE)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(suite.rglob('*')) if p.is_file()}
    return hashlib.sha256(''.join(f'{k}\0{v}\n'
                                 for k, v in sorted(files.items())).encode()).hexdigest()


def check_manifest(suite, run_check=True):
    """Refuse to run against fixtures that no longer match MANIFEST.json."""
    manifest = HERE / 'MANIFEST.json'
    if not run_check or not manifest.exists():
        return
    expected = json.loads(manifest.read_text())['aggregate']
    actual = suite_digest(suite)
    if actual != expected:
        sys.exit(f'fixture drift: suite digest {actual[:16]} != manifest {expected[:16]}; '
                 'rerun the published blocks or update MANIFEST.json deliberately')


def load_token():
    tok = os.environ.get('COMPANY_LLM_TOKEN')
    if tok:
        return tok
    try:
        import yaml
        creds = pathlib.Path.home() / '.dsh/.credentials.yaml'
        return yaml.safe_load(creds.read_text())['refs']['COMPANY_LLM_TOKEN']
    except Exception as exc:  # noqa: BLE001 - surfaced below as a hard error
        sys.exit(f'cannot resolve COMPANY_LLM_TOKEN: {exc}')


def load_task(suite, task):
    d = suite / task
    meta = json.loads((d / 'meta.json').read_text())
    meta['prompt'] = (d / 'PROMPT.txt').read_text().strip()
    meta['hidden'] = (d / 'hidden' / f"test_{task}.py").read_text()
    meta['seed'] = d / meta['seed'] if meta.get('seed') else None
    meta['testmod'] = f'test_hidden_{task}'
    meta['dir'] = d
    return meta


def hide_fixtures(metas):
    """Deny read/traverse on the graders and reference solutions for a block.

    A model that runs as this user can read any path the user can read, so an
    ordinary `find` or `grep` is enough to reach the fixture. Nothing in the
    runner needs those two directories once the prompts and test modules are in
    memory: the seed files are copied before the model starts and grading writes
    the already-loaded test module into a scratch copy. The directories are set
    back before the block returns, including on SIGINT/SIGTERM.
    """
    dirs = []
    for meta in metas.values():
        for name in ('hidden', 'ref'):
            d = meta['dir'] / name
            if d.is_dir():
                dirs.append(d)
                d.chmod(0o000)
    return dirs


def restore_fixtures(dirs):
    for d in dirs:
        try:
            d.chmod(0o755)
        except OSError:
            pass


def verify(dest, meta):
    """Grade the artifact. Returns hasEntry / passed / total / green.

    Grading happens in a scratch copy, not in the run directory: a task is free to
    leave its working directory read-only (the `shellops` arm did, with `chmod -R
    a-w`, which crashed the block with EACCES when the hidden test was written in
    place). The copy also keeps files the hidden test creates out of the artifact
    that `hasEntry` looks at.
    """
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='grade-'))
    work = tmp / 'w'
    try:
        shutil.copytree(dest, work, symlinks=True)
        for q in [work, *work.rglob('*')]:
            try:
                q.chmod(q.stat().st_mode | 0o600)
            except OSError:
                pass
        (work / f"{meta['testmod']}.py").write_text(meta['hidden'])
        p = subprocess.run(['python3', '-m', 'unittest', meta['testmod']], cwd=work,
                           capture_output=True, text=True, timeout=300)
        out = p.stdout + p.stderr
        ran = re.search(r'Ran (\d+) test', out)
        total = int(ran.group(1)) if ran else meta.get('tests', 0)
        bad = 0
        m = re.search(r'FAILED \(([^)]*)\)', out)
        if m:
            for _k, v in re.findall(r'(\w+)=(\d+)', m.group(1)):
                bad += int(v)
        elif 'OK' not in out:
            bad = max(total, 1)
        entry = dest / meta['entrypoint']
        return {'hasEntry': entry.exists(), 'passed': max(total - bad, 0), 'total': total,
                'green': p.returncode == 0}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def force_rmtree(path):
    """Remove a run directory a task may have chmod-ed read-only."""
    if not path.exists():
        return
    for q in [path, *path.rglob('*')]:
        try:
            q.chmod(q.stat().st_mode | 0o700)
        except OSError:
            pass
    shutil.rmtree(path, ignore_errors=True)


def run_one(cfg, arm, meta, tag):
    dest = cfg['runs'] / tag
    if dest.exists():
        force_rmtree(dest)
    dest.mkdir(parents=True)
    if meta['seed']:
        for item in meta['seed'].iterdir():
            (shutil.copytree if item.is_dir() else shutil.copy2)(item, dest / item.name)
    met = cfg['met']
    off = met.stat().st_size if met.exists() else 0
    pre_sids = session_ids(dest)  # a resumed cell keeps earlier session dirs around
    # Reminder evidence. The plugin records a directive only in its debug log, so
    # the arm is run with debug on for this cell; the log path is a sibling of the
    # run dir (never inside the artifact) and is deleted after the row is built.
    dbg = cfg['runs'] / f'{dest.name}.debug'
    patch = cfg['runs'] / f'{dest.name}.arm.yml'
    for stale in (dbg, patch):
        stale.unlink(missing_ok=True)
    try:
        patch.write_text(observed_arm(cfg['arms'] / f'{arm}.yml', dbg))
    except OSError:
        patch = cfg['arms'] / f'{arm}.yml'
    t0 = time.time()
    try:
        p = subprocess.run([cfg['exe'], cfg['cli'], 'bench', '--patch',
                            str(patch), meta['prompt']],
                           cwd=dest, env=cfg['env'], capture_output=True, text=True,
                           timeout=TOKEN_TIMEOUT)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        rc = -9
    wall = time.time() - t0
    time.sleep(0.4)
    rows = [json.loads(l) for l in met.read_text()[off:].splitlines() if l.strip()]
    rows = [r for r in rows if r.get('v') == 2]
    # The metrics file is shared with every other session on the machine, so a
    # bare byte-window happily counts the interactive session's steps too.
    # Keep only rows that belong to this run's own session ids.
    sids = session_ids(dest) - pre_sids
    mine = [r for r in rows if r.get('sid') in sids] if sids else rows
    events = reminder_events(dbg)
    counts = {}
    for ev in events:
        counts[ev['kind']] = counts.get(ev['kind'], 0) + 1
    # `hasSessionIds` says the row's steps/out were attributable to this run's own
    # sessions -- it is not artifact exactness. Historical rows wrote the same
    # boolean as `exact`; readers fall back to that key.
    row = {'task': meta['id'], 'arm': arm, 'wall': round(wall, 2), 'exit': rc,
           'steps': len(mine), 'stepsRaw': len(rows), 'sids': len(sids),
           'hasSessionIds': bool(sids),
           'llm': round(sum(r.get('llmMs') or 0 for r in mine) / 1000, 2),
           'out': sum(r.get('output') or 0 for r in mine),
           'reasoning': sum(r.get('reasoningChars') or 0 for r in mine),
           'textChars': sum(r.get('textChars') or 0 for r in mine),
           'leak': leak_scan(dest),
           'armConfig': cfg['armconfigs'].get(arm),
           'reminders': events, 'reminderCounts': counts, **verify(dest, meta)}
    # A run counts only when a session actually ran and grading completed: a
    # crash at session startup is `exit=1 / 0 steps / 0 output`, which an old
    # reading either scored as a fast run or as a red gate. It is neither.
    row['valid'] = (row['exit'] == 0 and row['steps'] >= 1 and row['out'] > 0
                    and row['hasEntry'] and row['total'] > 0 and not row['leak'])
    for stale in (dbg, patch):
        try:
            stale.unlink(missing_ok=True)
        except OSError:
            pass
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tasks', required=True)
    ap.add_argument('--arms', required=True)
    ap.add_argument('--pairs', type=int, default=4)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--suite', default=str(HERE / 'suite'))
    ap.add_argument('--arms-dir', default=str(HERE / 'arms'))
    ap.add_argument('--results', default=str(HERE / 'results'))
    ap.add_argument('--runs', default=str(DEFAULT_RUNS))
    ap.add_argument('--met', default=str(DEFAULT_MET))
    ap.add_argument('--dsh-exe', default=os.environ.get('DSH_BENCH_EXE', DEFAULT_EXE))
    ap.add_argument('--dsh-cli', default=os.environ.get('DSH_BENCH_CLI', DEFAULT_CLI))
    ap.add_argument('--no-manifest-check', action='store_true')
    a = ap.parse_args()

    suite, arms_dir = pathlib.Path(a.suite), pathlib.Path(a.arms_dir)
    check_manifest(suite, not a.no_manifest_check)
    results, runs = pathlib.Path(a.results), pathlib.Path(a.runs)
    results.mkdir(parents=True, exist_ok=True)
    runs.mkdir(parents=True, exist_ok=True)
    out = results / f'suite-{a.tag}.jsonl'
    cfg = {'runs': runs, 'met': pathlib.Path(a.met), 'arms': arms_dir,
           'exe': a.dsh_exe, 'cli': a.dsh_cli,
           'env': dict(os.environ, COMPANY_LLM_TOKEN=load_token(),
                       ELECTRON_RUN_AS_NODE='1',
                       DSH_FAST_MODE_METRICS_MAX_BYTES='268435456')}

    tasks = [t.strip() for t in a.tasks.split(',') if t.strip()]
    arms = [x.strip() for x in a.arms.split(',') if x.strip()]
    # Record what each arm resolves to once per block, so every row answers "what
    # was this arm allowed to emit" without re-reading the YAML later.
    cfg['armconfigs'] = {arm: arm_summary(resolve_arm(arms_dir / f'{arm}.yml'))
                         for arm in arms}
    metas = {t: load_task(suite, t) for t in tasks}
    done = set()
    if out.exists():
        for line in out.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                done.add((r['task'], r['pair'], r['arm']))

    hidden = hide_fixtures(metas)

    def restore(signum, _frame):
        restore_fixtures(hidden)
        raise SystemExit(128 + signum)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, restore)
    try:
        for i in range(1, a.pairs + 1):
            rotated = tasks[i % len(tasks):] + tasks[:i % len(tasks)] if tasks else tasks
            for task in rotated:
                meta = metas[task]
                order = arms if i % 2 else list(reversed(arms))
                for arm in order:
                    if (task, i, arm) in done:
                        print(f'skip {task} p{i} {arm}', flush=True)
                        continue
                    row = run_one(cfg, arm, meta, f'suite-{a.tag}-{task}-p{i}-{arm}')
                    row['pair'] = i
                    with out.open('a') as f:
                        f.write(json.dumps(row, ensure_ascii=False) + '\n')
                    print(json.dumps(row, ensure_ascii=False), flush=True)
    finally:
        restore_fixtures(hidden)

    print(f'\nrows: {out}', flush=True)


if __name__ == '__main__':
    main()
