import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MldSnoopingStateMachine } from './state-machine.js';

/**
 * Drive the state machine over an event script.
 *
 * - Events are applied in (tick, input-order); each tick first expires timers.
 * - A `restart` event persists the state and reloads a fresh instance from
 *   the state file, simulating a process restart (requires statePath).
 * - One forwarding decision is emitted per time slice and appended to
 *   decisionsPath (JSONL); applied events are appended to eventsLogPath.
 */
export function runEvents({
  events,
  statePath,
  decisionsPath = null,
  eventsLogPath = null,
  config = {},
  horizon = null,
}) {
  let sm = MldSnoopingStateMachine.loadOrCreate(statePath, config);
  const sorted = [...events].sort((a, b) => a.tick - b.tick); // Array.sort is stable
  const byTick = new Map();
  for (const ev of sorted) {
    if (!byTick.has(ev.tick)) byTick.set(ev.tick, []);
    byTick.get(ev.tick).push(ev);
  }
  const lastEventTick = sorted.length ? sorted[sorted.length - 1].tick : 0;
  const maxTick = Math.max(sm.tick, lastEventTick, horizon ?? lastEventTick);

  const decisions = [];
  const applied = [];
  for (let t = sm.tick + 1; t <= maxTick; t++) {
    sm.tick = t;
    sm.expireAt(t);
    for (const ev of byTick.get(t) ?? []) {
      if (ev.type === 'restart') {
        if (!sm.statePath) throw new Error('restart event requires a statePath');
        sm.save();
        sm = MldSnoopingStateMachine.load(sm.statePath);
        applied.push({ ...ev, id: ev.id ?? `evt-restart-${t}` });
        continue;
      }
      const result = sm.applyEvent(ev);
      if (result.applied) applied.push({ ...ev, id: result.id });
    }
    sm.save();
    decisions.push(sm.snapshotDecision());
  }

  if (decisionsPath && decisions.length) {
    mkdirSync(dirname(decisionsPath), { recursive: true });
    appendFileSync(decisionsPath, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');
  }
  if (eventsLogPath && applied.length) {
    mkdirSync(dirname(eventsLogPath), { recursive: true });
    appendFileSync(eventsLogPath, applied.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return { stateMachine: sm, decisions, appliedEvents: applied };
}
