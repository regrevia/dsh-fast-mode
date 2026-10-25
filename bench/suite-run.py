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
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_EXE = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
DEFAULT_CLI = ('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/'
               'node_modules/@deepseek-ai/dsh/lib/bin.js')
DEFAULT_MET = pathlib.Path.home() / '.dsh/fast-mode-metrics.jsonl'
TOKEN_TIMEOUT = 1500


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
    return meta


def verify(dest, meta):
    """Grade the artifact. Returns hasEntry / passed / total / green."""
    (dest / f"{meta['testmod']}.py").write_text(meta['hidden'])
    try:
        p = subprocess.run(['python3', '-m', 'unittest', meta['testmod']], cwd=dest,
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
        try:
            (dest / f"{meta['testmod']}.py").unlink()
        except OSError:
            pass


def run_one(cfg, arm, meta, tag):
    dest = cfg['runs'] / tag
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    if meta['seed']:
        for item in meta['seed'].iterdir():
            (shutil.copytree if item.is_dir() else shutil.copy2)(item, dest / item.name)
    met = cfg['met']
    off = met.stat().st_size if met.exists() else 0
    t0 = time.time()
    try:
        p = subprocess.run([cfg['exe'], cfg['cli'], 'bench', '--patch',
                            str(cfg['arms'] / f'{arm}.yml'), meta['prompt']],
                           cwd=dest, env=cfg['env'], capture_output=True, text=True,
                           timeout=TOKEN_TIMEOUT)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        rc = -9
    wall = time.time() - t0
    time.sleep(0.4)
    rows = [json.loads(l) for l in met.read_text()[off:].splitlines() if l.strip()]
    rows = [r for r in rows if r.get('v') == 2]
    return {'task': meta['id'], 'arm': arm, 'wall': round(wall, 2), 'exit': rc,
            'steps': len(rows),
            'llm': round(sum(r.get('llmMs') or 0 for r in rows) / 1000, 2),
            'out': sum(r.get('output') or 0 for r in rows), **verify(dest, meta)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tasks', required=True)
    ap.add_argument('--arms', required=True)
    ap.add_argument('--pairs', type=int, default=4)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--suite', default=str(HERE / 'suite'))
    ap.add_argument('--arms-dir', default=str(HERE / 'arms'))
    ap.add_argument('--results', default=str(HERE / 'results'))
    ap.add_argument('--runs', default=str(HERE / '.runs'))
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
    done = set()
    if out.exists():
        for line in out.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                done.add((r['task'], r['pair'], r['arm']))

    for i in range(1, a.pairs + 1):
        rotated = tasks[i % len(tasks):] + tasks[:i % len(tasks)] if tasks else tasks
        for task in rotated:
            meta = load_task(suite, task)
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

    print(f'\nrows: {out}', flush=True)


if __name__ == '__main__':
    main()
