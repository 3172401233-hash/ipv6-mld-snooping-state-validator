import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  // Membership expires groupTimer ticks after the last Report (MLD group timer).
  groupTimer: 10,
  // Last-listener window = lastListenerInterval * lastListenerCount (MLD LMQC/LMQI).
  lastListenerInterval: 1,
  lastListenerCount: 2,
  // Router port expires routerPortTimer ticks after the last query/hello.
  routerPortTimer: 12,
});

export const WILDCARD_SOURCE = '*';

export function flowKey(group, source) {
  return `${group}|${source}`;
}

export function splitFlowKey(key) {
  const idx = key.lastIndexOf('|');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function memberKey(group, source, port) {
  return `${group}|${source}|${port}`;
}

/**
 * Persistent MLD snooping state machine.
 *
 * Pure control-plane simulation: it consumes JSON events and never sends or
 * receives real MLD packets. Time is discrete; every processed time slice
 * yields one forwarding decision via snapshotDecision().
 */
export class MldSnoopingStateMachine {
  constructor({ statePath = null, config = {} } = {}) {
    this.statePath = statePath;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tick = -1;
    this.routerPorts = new Map(); // port -> { port, expiresAt, lastEventId }
    this.members = new Map(); // group|source|port -> record
    this.processedEventIds = new Set();
    this.eventSeq = 0;
    this.pendingQueries = [];
  }

  static load(statePath) {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    if (raw.version !== 1) throw new Error(`unsupported state version: ${raw.version}`);
    const sm = new MldSnoopingStateMachine({ statePath, config: raw.config });
    sm.tick = raw.tick;
    sm.routerPorts = new Map(raw.routerPorts.map((r) => [r.port, { ...r }]));
    sm.members = new Map(
      raw.members.map((m) => [memberKey(m.group, m.source, m.port), { ...m }]),
    );
    sm.processedEventIds = new Set(raw.processedEventIds);
    sm.eventSeq = raw.eventSeq;
    return sm;
  }

  static loadOrCreate(statePath, config = {}) {
    if (statePath && existsSync(statePath)) return MldSnoopingStateMachine.load(statePath);
    return new MldSnoopingStateMachine({ statePath, config });
  }

  toJSON() {
    return {
      version: 1,
      tick: this.tick,
      config: this.config,
      routerPorts: [...this.routerPorts.values()].map((r) => ({ ...r })),
      members: [...this.members.values()].map((m) => ({ ...m })),
      processedEventIds: [...this.processedEventIds],
      eventSeq: this.eventSeq,
    };
  }

  save() {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.toJSON(), null, 2)}\n`);
    renameSync(tmp, this.statePath);
  }

  get leaveWindow() {
    return this.config.lastListenerInterval * this.config.lastListenerCount;
  }

  /** Expire memberships and router ports whose deadline is <= tick. */
  expireAt(tick) {
    for (const [key, m] of this.members) {
      const expiry =
        m.state === 'pending-leave' ? Math.min(m.expiresAt, m.leaveExpiresAt) : m.expiresAt;
      if (expiry <= tick) this.members.delete(key);
    }
    for (const [port, r] of this.routerPorts) {
      if (r.expiresAt <= tick) this.routerPorts.delete(port);
    }
  }

  /**
   * Apply one event at the current tick. Events carrying an `id` are
   * idempotent: an already-processed id is skipped (survives restarts).
   * Returns { applied, id }.
   */
  applyEvent(event) {
    if (event.id != null && this.processedEventIds.has(event.id)) {
      return { applied: false, id: event.id };
    }
    const id = event.id ?? `evt-${this.eventSeq++}`;
    const tick = this.tick;

    switch (event.type) {
      case 'report': {
        const mode = event.mode ?? 'include';
        const sources = event.sources ?? [];
        requireFields(event, ['port', 'group']);
        if (mode === 'include' && sources.length === 0) {
          // MLDv2 TO_IN({}) is semantically a leave for the whole group.
          this.handleDone(event.group, [], event.port, tick, id);
        } else if (mode === 'exclude') {
          if (sources.length > 0) {
            throw new Error('exclude mode with a non-empty source list is not supported');
          }
          this.upsertMember(event.group, WILDCARD_SOURCE, event.port, tick, id);
        } else {
          for (const source of sources) {
            this.upsertMember(event.group, source, event.port, tick, id);
          }
        }
        break;
      }
      case 'done': {
        requireFields(event, ['port', 'group']);
        this.handleDone(event.group, event.sources ?? [], event.port, tick, id);
        break;
      }
      case 'router-port-add': {
        requireFields(event, ['port']);
        this.routerPorts.set(event.port, {
          port: event.port,
          expiresAt: tick + this.config.routerPortTimer,
          lastEventId: id,
        });
        break;
      }
      case 'router-port-del': {
        requireFields(event, ['port']);
        this.routerPorts.delete(event.port);
        break;
      }
      case 'query': {
        // A (general) query received on a port (re)proves a multicast router
        // sits behind it and refreshes the router-port timer.
        if (event.port) {
          this.routerPorts.set(event.port, {
            port: event.port,
            expiresAt: tick + this.config.routerPortTimer,
            lastEventId: id,
          });
        }
        break;
      }
      case 'port-down': {
        requireFields(event, ['port']);
        for (const [key, m] of this.members) {
          if (m.port === event.port) this.members.delete(key);
        }
        this.routerPorts.delete(event.port);
        break;
      }
      case 'port-up': {
        requireFields(event, ['port']);
        break; // topology marker only; no membership yet
      }
      default:
        throw new Error(`unknown event type: ${event.type}`);
    }

    if (event.id != null) this.processedEventIds.add(event.id);
    return { applied: true, id };
  }

  upsertMember(group, source, port, tick, eventId) {
    const key = memberKey(group, source, port);
    const existing = this.members.get(key);
    if (existing) {
      // Refresh: a new Report cancels any pending leave and re-arms the timer.
      existing.state = 'active';
      existing.expiresAt = tick + this.config.groupTimer;
      existing.leaveExpiresAt = null;
      existing.lastReportAt = tick;
      existing.lastEventId = eventId;
    } else {
      this.members.set(key, {
        group,
        source,
        port,
        state: 'active',
        expiresAt: tick + this.config.groupTimer,
        leaveExpiresAt: null,
        joinedAt: tick,
        lastReportAt: tick,
        lastEventId: eventId,
      });
    }
  }

  handleDone(group, sources, port, tick, eventId) {
    for (const m of this.members.values()) {
      if (m.port !== port || m.group !== group) continue;
      if (sources.length > 0 && !sources.includes(m.source)) continue;
      if (m.state !== 'active') continue;
      // Do NOT prune immediately: start the last-listener window. A new
      // Report inside the window cancels the leave (see upsertMember).
      m.state = 'pending-leave';
      m.leaveExpiresAt = tick + this.leaveWindow;
      m.lastEventId = eventId;
      this.pendingQueries.push({
        type: 'group-source-specific-query',
        group,
        source: m.source,
        port,
        tick,
      });
    }
  }

  /** Forwarding port sets for the current tick: { "group|source": [ports] }. */
  computeForwarding() {
    const flows = new Map();
    for (const m of this.members.values()) {
      const key = flowKey(m.group, m.source);
      if (!flows.has(key)) flows.set(key, new Set());
      flows.get(key).add(m.port);
    }
    // ASM wildcard membership (group|*) also receives every source's traffic.
    for (const [key, ports] of flows) {
      const [group, source] = splitFlowKey(key);
      if (source === WILDCARD_SOURCE) continue;
      const wild = flows.get(flowKey(group, WILDCARD_SOURCE));
      if (wild) for (const p of wild) ports.add(p);
    }
    // Multicast router ports always receive registered flows.
    for (const ports of flows.values()) {
      for (const rp of this.routerPorts.keys()) ports.add(rp);
    }
    const out = {};
    for (const [key, ports] of [...flows.entries()].sort()) {
      out[key] = [...ports].sort();
    }
    return out;
  }

  snapshotDecision() {
    const decision = {
      tick: this.tick,
      flows: this.computeForwarding(),
      routerPorts: [...this.routerPorts.keys()].sort(),
      queries: this.pendingQueries,
    };
    this.pendingQueries = [];
    return decision;
  }
}

function requireFields(event, fields) {
  for (const f of fields) {
    if (event[f] == null) throw new Error(`event ${event.type} missing field: ${f}`);
  }
}
