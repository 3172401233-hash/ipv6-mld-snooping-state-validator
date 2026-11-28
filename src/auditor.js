import { DEFAULT_CONFIG, WILDCARD_SOURCE, flowKey, splitFlowKey } from './state-machine.js';

function eventRef(ev) {
  return { id: ev.id ?? null, tick: ev.tick, type: ev.type };
}

function memberKey(group, source, port) {
  return `${group}|${source}|${port}`;
}

/**
 * Independent reference model: replays the applied-event log and derives
 * membership/router-port validity intervals directly from the protocol
 * contract (Report opens/refreshes, Done closes after the last-listener
 * window, port-down closes immediately, timers expire). It shares no state
 * or code paths with the state machine's forwarding logic.
 */
export function buildReferenceModel(events, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const leaveWindow = cfg.lastListenerInterval * cfg.lastListenerCount;
  const memberIntervals = new Map(); // group|source|port -> interval[]
  const routerIntervals = new Map(); // port -> interval[]

  function openInterval(map, key, tick, ttl, ref, extra = {}) {
    const list = map.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && last.end > tick) {
      last.end = tick + ttl;
      last.refreshes.push(ref);
    } else {
      list.push({ start: tick, end: tick + ttl, openedBy: ref, refreshes: [], closedBy: null, ...extra });
    }
    map.set(key, list);
  }

  function openMember(group, source, port, ev) {
    openInterval(memberIntervals, memberKey(group, source, port), ev.tick, cfg.groupTimer,
      eventRef(ev), { group, source, port });
  }

  function closeMembers(group, sources, port, ev, hard) {
    for (const list of memberIntervals.values()) {
      const iv = list[list.length - 1];
      if (!iv || iv.group !== group || iv.port !== port) continue;
      if (sources && sources.length > 0 && !sources.includes(iv.source)) continue;
      if (iv.end <= ev.tick) continue;
      const closeAt = hard ? ev.tick : Math.min(iv.end, ev.tick + leaveWindow);
      if (closeAt < iv.end) {
        iv.end = closeAt;
        iv.closedBy = eventRef(ev);
      }
    }
  }

  function closePort(port, ev) {
    for (const list of memberIntervals.values()) {
      const iv = list[list.length - 1];
      if (iv && iv.port === port && iv.end > ev.tick) {
        iv.end = ev.tick;
        iv.closedBy = eventRef(ev);
      }
    }
    const rList = routerIntervals.get(port);
    const rIv = rList?.[rList.length - 1];
    if (rIv && rIv.end > ev.tick) {
      rIv.end = ev.tick;
      rIv.closedBy = eventRef(ev);
    }
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'report': {
        const mode = ev.mode ?? 'include';
        const sources = ev.sources ?? [];
        if (mode === 'include' && sources.length === 0) {
          closeMembers(ev.group, null, ev.port, ev, false);
        } else if (mode === 'exclude') {
          openMember(ev.group, WILDCARD_SOURCE, ev.port, ev);
        } else {
          for (const source of sources) openMember(ev.group, source, ev.port, ev);
        }
        break;
      }
      case 'done':
        closeMembers(ev.group, ev.sources ?? [], ev.port, ev, false);
        break;
      case 'port-down':
        closePort(ev.port, ev);
        break;
      case 'router-port-add':
        openInterval(routerIntervals, ev.port, ev.tick, cfg.routerPortTimer, eventRef(ev));
        break;
      case 'router-port-del': {
        const list = routerIntervals.get(ev.port);
        const iv = list?.[list.length - 1];
        if (iv && iv.end > ev.tick) {
          iv.end = ev.tick;
          iv.closedBy = eventRef(ev);
        }
        break;
      }
      case 'query':
        if (ev.port) openInterval(routerIntervals, ev.port, ev.tick, cfg.routerPortTimer, eventRef(ev));
        break;
      default:
        break; // restart / port-up markers carry no forwarding semantics
    }
  }

  function expectedFlowsAt(tick) {
    const flows = new Map();
    for (const list of memberIntervals.values()) {
      for (const iv of list) {
        if (iv.start <= tick && tick < iv.end) {
          const key = flowKey(iv.group, iv.source);
          if (!flows.has(key)) flows.set(key, new Set());
          flows.get(key).add(iv.port);
        }
      }
    }
    for (const [key, ports] of flows) {
      const [group, source] = splitFlowKey(key);
      if (source === WILDCARD_SOURCE) continue;
      const wild = flows.get(flowKey(group, WILDCARD_SOURCE));
      if (wild) for (const p of wild) ports.add(p);
    }
    const routers = new Set();
    for (const [port, list] of routerIntervals) {
      for (const iv of list) {
        if (iv.start <= tick && tick < iv.end) routers.add(port);
      }
    }
    for (const ports of flows.values()) {
      for (const rp of routers) ports.add(rp);
    }
    return flows;
  }

  return { memberIntervals, routerIntervals, expectedFlowsAt, config: cfg };
}

function memberEvidence(model, group, source, port, tick, covering) {
  const list = model.memberIntervals.get(memberKey(group, source, port)) ?? [];
  let best = null;
  for (const iv of list) {
    if (covering) {
      if (iv.start <= tick && tick < iv.end) {
        best = iv;
        break;
      }
    } else if (!best || iv.start <= tick) {
      best = iv;
    }
  }
  if (!best) {
    const rList = model.routerIntervals.get(port) ?? [];
    const rIv = rList.find((iv) => iv.start <= tick) ?? rList[rList.length - 1];
    if (!rIv) return [];
    return [rIv.openedBy, rIv.closedBy].filter(Boolean);
  }
  return [best.openedBy, ...best.refreshes, best.closedBy].filter(Boolean);
}

/**
 * Audit the state machine's persisted output against the reference model.
 *
 * @param {object[]} events   applied-event log (JSONL records)
 * @param {object[]} decisions forwarding decisions, one per time slice
 * @param {object}   [state]  parsed state file (checked for duplicate members)
 * @returns findings: { type, tick, group, source, port, evidence, message }[]
 *   type is one of 'erroneous-flooding' | 'erroneous-pruning' | 'duplicate-member'
 */
export function audit({ events, decisions, state = null, config = {} }) {
  const model = buildReferenceModel(events, config);
  const findings = [];

  for (const rec of decisions) {
    const expected = model.expectedFlowsAt(rec.tick);
    const actualFlows = rec.flows ?? {};
    const keys = new Set([...expected.keys(), ...Object.keys(actualFlows)]);
    for (const key of keys) {
      const [group, source] = splitFlowKey(key);
      const exp = expected.get(key) ?? new Set();
      const raw = actualFlows[key] ?? [];
      const act = new Set();
      for (const port of raw) {
        if (act.has(port)) {
          findings.push({
            type: 'duplicate-member',
            tick: rec.tick,
            group,
            source,
            port,
            evidence: memberEvidence(model, group, source, port, rec.tick, true),
            message: `转发决策中端口 ${port} 在组 ${group} 源 ${source} 上出现重复成员`,
          });
        }
        act.add(port);
      }
      for (const port of exp) {
        if (!act.has(port)) {
          findings.push({
            type: 'erroneous-pruning',
            tick: rec.tick,
            group,
            source,
            port,
            evidence: memberEvidence(model, group, source, port, rec.tick, true),
            message: `tick ${rec.tick}: 端口 ${port} 对组 ${group} 源 ${source} 的成员关系仍有效，却被剪枝`,
          });
        }
      }
      for (const port of act) {
        if (!exp.has(port)) {
          findings.push({
            type: 'erroneous-flooding',
            tick: rec.tick,
            group,
            source,
            port,
            evidence: memberEvidence(model, group, source, port, rec.tick, false),
            message: `tick ${rec.tick}: 端口 ${port} 对组 ${group} 源 ${source} 无有效成员关系/路由器身份，却被泛洪`,
          });
        }
      }
    }
  }

  if (state?.members) {
    const byKey = new Map();
    for (const m of state.members) {
      const key = memberKey(m.group, m.source, m.port);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(m);
    }
    for (const records of byKey.values()) {
      if (records.length < 2) continue;
      const { group, source, port } = records[0];
      findings.push({
        type: 'duplicate-member',
        tick: state.tick ?? null,
        group,
        source,
        port,
        evidence: records.map((r) => ({ id: r.lastEventId ?? null, tick: r.lastReportAt ?? null, type: 'state-record' })),
        message: `状态文件中组 ${group} 源 ${source} 端口 ${port} 存在 ${records.length} 条重复成员记录`,
      });
    }
  }

  return findings;
}
