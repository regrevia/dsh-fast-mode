"""Hidden acceptance tests for the stategraph fixture.

Run from the run directory (the directory holding machine.mjs):

    python3 -m unittest test_stategraph

A Node.js runtime must be on PATH. No network, no third-party packages.
"""

import json
import subprocess
import unittest
from pathlib import Path

RUN_DIR = Path(__file__).resolve().parent
PRELUDE = 'import { createMachine, fromJSON } from "./machine.mjs";\n'


def run_node(body, timeout=25):
    """Run an ES module snippet in RUN_DIR and return its decoded JSON stdout."""
    source = PRELUDE + body
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        cwd=str(RUN_DIR),
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise AssertionError(
            "node exited with %s\n--- stdout ---\n%s\n--- stderr ---\n%s"
            % (proc.returncode, proc.stdout, proc.stderr)
        )
    text = proc.stdout.strip()
    if not text:
        raise AssertionError("node produced no output\nstderr:\n%s" % proc.stderr)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise AssertionError("node stdout was not JSON: %r (%s)" % (text, exc))


def guarded(body):
    """Wrap body so thrown errors are reported as {"error": message}."""
    return (
        "const out = {};\n"
        "try {\n"
        + body
        + "\n} catch (e) { out.error = String(e.message); out.name = e.name; }\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )


BASIC_DEF = """
const def = {
  states: ["idle", "running", "paused", "done"],
  transitions: [
    { from: "idle", event: "start", to: "running" },
    { from: "running", event: "pause", to: "paused" },
    { from: "paused", event: "resume", to: "running" },
    { from: "running", event: "finish", to: "done" },
  ],
};
"""


class TestStateGraph(unittest.TestCase):
    def test_happy_path_single_transition(self):
        data = run_node(
            guarded(
                BASIC_DEF
                + """
const m = createMachine(def);
const r = m.send("start");
out.result = { state: r.state, changed: r.changed, history: r.history.map((e) => ({ ...e })) };
out.machineState = m.state;
out.json = m.toJSON();
"""
            )
        )
        self.assertNotIn("error", data, data)
        self.assertEqual(data["result"]["state"], "running")
        self.assertIs(data["result"]["changed"], True)
        self.assertEqual(
            data["result"]["history"],
            [{"from": "idle", "event": "start", "to": "running"}],
        )
        self.assertEqual(data["machineState"], "running")
        self.assertEqual(
            data["json"], {"state": "running", "history": [{"from": "idle", "event": "start", "to": "running"}]}
        )

    def test_three_step_sequence_history(self):
        data = run_node(
            guarded(
                BASIC_DEF
                + """
const m = createMachine(def);
const a = m.send("start");
const b = m.send("pause");
const c = m.send("resume");
out.result = {
  state: c.state,
  changed: [a.changed, b.changed, c.changed],
  history: c.history.map((e) => ({ ...e })),
  length: c.history.length,
  prevLengths: [a.history.length, b.history.length],
};
"""
            )
        )
        self.assertNotIn("error", data, data)
        self.assertEqual(data["result"]["state"], "running")
        self.assertEqual(data["result"]["changed"], [True, True, True])
        self.assertEqual(data["result"]["prevLengths"], [1, 2])
        self.assertEqual(data["result"]["length"], 3)
        self.assertEqual(
            data["result"]["history"],
            [
                {"from": "idle", "event": "start", "to": "running"},
                {"from": "running", "event": "pause", "to": "paused"},
                {"from": "paused", "event": "resume", "to": "running"},
            ],
        )

    def test_guard_fallback_and_guard_rejection(self):
        data = run_node(
            guarded(
                """
let guardedCalls = 0;
const def = {
  states: ["idle", "blocked", "ready"],
  transitions: [
    { from: "idle", event: "go", to: "blocked", guard: () => { guardedCalls += 1; return false; } },
    { from: "idle", event: "go", to: "ready", guard: () => { guardedCalls += 1; return true; } },
    { from: "ready", event: "go", to: "blocked", guard: () => { guardedCalls += 1; return false; } },
  ],
};
const m = createMachine(def);
const first = m.send("go");
const second = m.send("go");
out.result = {
  firstState: first.state,
  firstChanged: first.changed,
  secondState: second.state,
  secondChanged: second.changed,
  secondHistory: second.history.map((e) => ({ ...e })),
  machineState: m.state,
  json: m.toJSON(),
  guardCalls: guardedCalls,
};
"""
            )
        )
        self.assertNotIn("error", data, data)
        self.assertEqual(data["result"]["firstState"], "ready")
        self.assertIs(data["result"]["firstChanged"], True)
        self.assertEqual(data["result"]["secondState"], "ready")
        self.assertIs(data["result"]["secondChanged"], False)
        self.assertEqual(
            data["result"]["secondHistory"],
            [{"from": "idle", "event": "go", "to": "ready"}],
        )
        # no-op must not append and current state must not change
        self.assertEqual(data["result"]["machineState"], "ready")
        self.assertEqual(
            data["result"]["json"],
            {"state": "ready", "history": [{"from": "idle", "event": "go", "to": "ready"}]},
        )
        # two candidates were evaluated once each, the last one guard false once
        self.assertEqual(data["result"]["guardCalls"], 3)

    def test_unknown_event_throws_with_exact_message(self):
        data = run_node(
            guarded(
                BASIC_DEF
                + """
const m = createMachine(def);
const before = m.toJSON();
let threw = false;
let message = "";
try { m.send("jump"); } catch (e) { threw = true; message = e.message; }
out.result = { threw, message, before, after: m.toJSON(), state: m.state };
"""
            )
        )
        self.assertNotIn("error", data, data)
        self.assertIs(data["result"]["threw"], True)
        self.assertEqual(data["result"]["message"], "unknown event: jump for state idle")
        self.assertEqual(data["result"]["state"], "idle")
        self.assertEqual(data["result"]["after"], {"state": "idle", "history": []})
        self.assertEqual(data["result"]["before"], {"state": "idle", "history": []})

    def test_history_is_frozen_and_defensively_copied(self):
        data = run_node(
            guarded(
                BASIC_DEF
                + """
const m = createMachine(def);
const first = m.send("start");
const second = m.send("pause");
let pushThrew = false;
try { first.history.push({ from: "x", event: "y", to: "z" }); } catch (e) { pushThrew = e instanceof TypeError; }
let entryWriteThrew = false;
try { first.history[0].from = "hacked"; } catch (e) { entryWriteThrew = e instanceof TypeError; }
out.result = {
  frozenArray: Object.isFrozen(first.history),
  frozenEntry: Object.isFrozen(first.history[0]),
  pushThrew,
  entryWriteThrew,
  distinctArrays: first.history !== second.history,
  firstContents: first.history.map((e) => ({ ...e })),
  secondContents: second.history.map((e) => ({ ...e })),
  savedSnapshotAfterMutation: m.toJSON(),
};
"""
            )
        )
        self.assertNotIn("error", data, data)
        res = data["result"]
        self.assertIs(res["frozenArray"], True)
        self.assertIs(res["frozenEntry"], True)
        self.assertIs(res["pushThrew"], True)
        self.assertIs(res["entryWriteThrew"], True)
        self.assertIs(res["distinctArrays"], True)
        self.assertEqual(
            res["firstContents"], [{"from": "idle", "event": "start", "to": "running"}]
        )
        self.assertEqual(
            res["secondContents"],
            [
                {"from": "idle", "event": "start", "to": "running"},
                {"from": "running", "event": "pause", "to": "paused"},
            ],
        )
        self.assertEqual(res["savedSnapshotAfterMutation"]["history"], res["secondContents"])

    def test_round_trip_preserves_state_and_history_and_continues(self):
        data = run_node(
            guarded(
                BASIC_DEF
                + """
const m = createMachine(def);
m.send("start");
m.send("pause");
const snapshot = m.toJSON();
const restored = fromJSON(snapshot, def);
const restoredJson = restored.toJSON();
const restoredState = restored.state;
const continued = restored.send("resume");
out.result = {
  snapshot,
  snapshotJson: JSON.parse(JSON.stringify(snapshot)),
  restoredJson,
  restoredState,
  originalState: m.state,
  originalJson: m.toJSON(),
  continuedState: continued.state,
  continuedHistory: continued.history.map((e) => ({ ...e })),
  originalAfterContinue: m.toJSON(),
};
"""
            )
        )
        self.assertNotIn("error", data, data)
        res = data["result"]
        self.assertEqual(res["restoredJson"], res["snapshot"])
        self.assertEqual(res["snapshotJson"], res["snapshot"])
        self.assertEqual(res["restoredState"], "paused")
        self.assertEqual(res["originalState"], "paused")
        self.assertEqual(
            res["continuedHistory"],
            [
                {"from": "idle", "event": "start", "to": "running"},
                {"from": "running", "event": "pause", "to": "paused"},
                {"from": "paused", "event": "resume", "to": "running"},
            ],
        )
        self.assertEqual(res["continuedState"], "running")
        # the original machine must not be affected by the restored one
        self.assertEqual(res["originalAfterContinue"], res["originalJson"])
        self.assertEqual(len(res["originalJson"]["history"]), 2)

    def test_fromjson_rejects_invalid_state(self):
        data = run_node(
            guarded(
                BASIC_DEF
                + """
try {
  fromJSON({ state: "ghost", history: [] }, def);
  out.result = { threw: false };
} catch (e) {
  out.result = { threw: true, message: e.message, isError: e instanceof Error };
}
"""
            )
        )
        self.assertNotIn("error", data, data)
        self.assertIs(data["result"]["threw"], True)
        self.assertIs(data["result"]["isError"], True)
        self.assertEqual(data["result"]["message"], "invalid state: ghost")

    def test_fromjson_rejects_bad_snapshots(self):
        data = run_node(
            guarded(
                BASIC_DEF
                + """
const messages = {};
for (const [label, snapshot] of [
  ["nullish", null],
  ["badHistory", { state: "idle", history: "nope" }],
  ["badChain", { state: "idle", history: [{ from: "idle", event: "start", to: "running" }] }],
  ["badEntry", { state: "idle", history: [{ from: "idle", event: "start" }] }],
]) {
  try { fromJSON(snapshot, def); messages[label] = "NO ERROR"; }
  catch (e) { messages[label] = e.message; }
}
out.result = messages;
"""
            )
        )
        self.assertNotIn("error", data, data)
        messages = data["result"]
        self.assertEqual(messages["nullish"], "snapshot must be an object")
        self.assertEqual(messages["badHistory"], "history must be an array")
        self.assertIn("history is inconsistent", messages["badChain"])
        self.assertIn("history is inconsistent", messages["badEntry"])

    def test_definition_validation(self):
        data = run_node(
            guarded(
                """
const messages = {};
const cases = {
  notObject: () => createMachine(null),
  emptyStates: () => createMachine({ states: [], transitions: [] }),
  duplicateStates: () => createMachine({ states: ["a", "a"], transitions: [] }),
  badTransitions: () => createMachine({ states: ["a"], transitions: {} }),
  badTarget: () => createMachine({ states: ["a"], transitions: [{ from: "a", event: "go", to: "nowhere" }] }),
  badSource: () => createMachine({ states: ["a"], transitions: [{ from: "elsewhere", event: "go", to: "a" }] }),
  badGuard: () => createMachine({ states: ["a"], transitions: [{ from: "a", event: "go", to: "a", guard: 3 }] }),
};
for (const [label, fn] of Object.entries(cases)) {
  try { fn(); messages[label] = "NO ERROR"; } catch (e) { messages[label] = e.message; }
}
out.result = messages;
"""
            )
        )
        self.assertNotIn("error", data, data)
        messages = data["result"]
        self.assertEqual(messages["notObject"], "definition must be an object")
        self.assertIn("states must be a non-empty array", messages["emptyStates"])
        self.assertIn("states must be a non-empty array", messages["duplicateStates"])
        self.assertEqual(messages["badTransitions"], "transitions must be an array")
        self.assertEqual(messages["badTarget"], "unknown target state: nowhere")
        self.assertEqual(messages["badSource"], "unknown source state: elsewhere")
        self.assertEqual(messages["badGuard"], "invalid transition at index 0")

    def test_self_transition_counts_as_changed(self):
        data = run_node(
            guarded(
                """
const def = {
  states: ["idle", "done"],
  transitions: [
    { from: "idle", event: "tick", to: "idle" },
    { from: "idle", event: "finish", to: "done" },
  ],
};
const m = createMachine(def);
const tick = m.send("tick");
const finish = m.send("finish");
out.result = {
  tickChanged: tick.changed,
  tickState: tick.state,
  tickHistory: tick.history.map((e) => ({ ...e })),
  finishState: finish.state,
  finishHistoryLength: finish.history.length,
};
"""
            )
        )
        self.assertNotIn("error", data, data)
        res = data["result"]
        self.assertIs(res["tickChanged"], True)
        self.assertEqual(res["tickState"], "idle")
        self.assertEqual(res["tickHistory"], [{"from": "idle", "event": "tick", "to": "idle"}])
        self.assertEqual(res["finishState"], "done")
        self.assertEqual(res["finishHistoryLength"], 2)


if __name__ == "__main__":
    unittest.main()
