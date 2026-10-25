// Reference implementation: small guarded state machine.
// No dependencies. ESM.

function fail(message) {
  throw new Error(message);
}

function deepFreezeHistory(entries) {
  const copy = entries.map((entry) =>
    Object.freeze({ from: entry.from, event: entry.event, to: entry.to })
  );
  return Object.freeze(copy);
}

function normalizeDefinition(definition) {
  if (definition === null || typeof definition !== "object") {
    fail("definition must be an object");
  }
  const { states, transitions } = definition;
  if (!Array.isArray(states) || states.length === 0) {
    fail("states must be a non-empty array of unique non-empty strings");
  }
  const seen = new Set();
  for (const name of states) {
    if (typeof name !== "string" || name.length === 0) {
      fail("states must be a non-empty array of unique non-empty strings");
    }
    if (seen.has(name)) {
      fail("states must be a non-empty array of unique non-empty strings");
    }
    seen.add(name);
  }
  if (!Array.isArray(transitions)) {
    fail("transitions must be an array");
  }
  transitions.forEach((transition, index) => {
    if (transition === null || typeof transition !== "object") {
      fail(`invalid transition at index ${index}`);
    }
    if (typeof transition.event !== "string" || transition.event.length === 0) {
      fail(`invalid transition at index ${index}`);
    }
    if (transition.guard !== undefined && typeof transition.guard !== "function") {
      fail(`invalid transition at index ${index}`);
    }
    if (!seen.has(transition.from)) {
      fail(`unknown source state: ${String(transition.from)}`);
    }
    if (!seen.has(transition.to)) {
      fail(`unknown target state: ${String(transition.to)}`);
    }
  });
  return { states, transitions };
}

function build(definition, restoredState, restoredHistory) {
  const { states, transitions } = normalizeDefinition(definition);
  let state = restoredState === undefined ? states[0] : restoredState;
  let history =
    restoredHistory === undefined ? Object.freeze([]) : deepFreezeHistory(restoredHistory);

  return {
    get state() {
      return state;
    },
    send(event) {
      const candidates = transitions.filter(
        (transition) => transition.from === state && transition.event === event
      );
      if (candidates.length === 0) {
        fail(`unknown event: ${event} for state ${state}`);
      }
      for (const transition of candidates) {
        const allowed = transition.guard === undefined || Boolean(transition.guard());
        if (!allowed) {
          continue;
        }
        const entry = Object.freeze({ from: state, event: transition.event, to: transition.to });
        history = Object.freeze([...history, entry]);
        state = transition.to;
        return { state, changed: true, history: Object.freeze([...history]) };
      }
      return { state, changed: false, history: Object.freeze([...history]) };
    },
    toJSON() {
      return {
        state,
        history: history.map((entry) => ({
          from: entry.from,
          event: entry.event,
          to: entry.to,
        })),
      };
    },
  };
}

export function createMachine(definition) {
  return build(definition);
}

export function fromJSON(snapshot, definition) {
  if (snapshot === null || typeof snapshot !== "object") {
    fail("snapshot must be an object");
  }
  const { states } = normalizeDefinition(definition);
  if (!states.includes(snapshot.state)) {
    fail(`invalid state: ${String(snapshot.state)}`);
  }
  if (!Array.isArray(snapshot.history)) {
    fail("history must be an array");
  }
  const entries = [];
  let expectedFrom = states[0];
  for (let index = 0; index < snapshot.history.length; index += 1) {
    const candidate = snapshot.history[index];
    if (candidate === null || typeof candidate !== "object") {
      fail("history is inconsistent");
    }
    const { from, event, to } = candidate;
    if (!states.includes(from) || !states.includes(to)) {
      fail("history is inconsistent");
    }
    if (typeof event !== "string" || event.length === 0) {
      fail("history is inconsistent");
    }
    if (from !== expectedFrom) {
      fail("history is inconsistent");
    }
    entries.push({ from, event, to });
    expectedFrom = to;
  }
  if (entries.length > 0) {
    if (entries[entries.length - 1].to !== snapshot.state) {
      fail("history is inconsistent");
    }
  } else if (snapshot.state !== states[0]) {
    fail("history is inconsistent");
  }
  return build(definition, snapshot.state, entries);
}
