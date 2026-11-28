import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvents } from '../src/runner.js';
import { audit } from '../src/auditor.js';
import { G, S1, TEST_CONFIG, keyOf, makeWorkspace, readJsonl, readState } from './helpers.js';

const EVENTS = [
  { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
  { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
  { tick: 2, id: 'l1', type: 'done', port: 'p1', group: G, sources: [S1] },
  { tick: 3, id: 'j2', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
];

function goodRun() {
  const ws = makeWorkspace();
  runEvents({
    events: EVENTS,
    statePath: ws.statePath,
    decisionsPath: ws.decisionsPath,
    eventsLogPath: ws.eventsLogPath,
    config: TEST_CONFIG,
    horizon: 8,
  });
  return {
    events: readJsonl(ws.eventsLogPath),
    decisions: readJsonl(ws.decisionsPath),
    state: readState(ws.statePath),
  };
}

test('审计器：正常运行的状态机不产生任何发现', () => {
  const { events, decisions, state } = goodRun();
  assert.deepEqual(audit({ events, decisions, state, config: TEST_CONFIG }), []);
});

test('审计器：检测误剪枝并给出组/源/端口与证据事件', () => {
  const { events, decisions, state } = goodRun();
  const key = keyOf(G, S1);
  // 注入交换机 bug：tick 2（last-listener 窗口内）提前剪掉 p1
  decisions[2].flows[key] = decisions[2].flows[key].filter((p) => p !== 'p1');
  const findings = audit({ events, decisions, state, config: TEST_CONFIG });

  const pruning = findings.filter((f) => f.type === 'erroneous-pruning');
  assert.equal(pruning.length, 1);
  assert.equal(pruning[0].tick, 2);
  assert.equal(pruning[0].group, G);
  assert.equal(pruning[0].source, S1);
  assert.equal(pruning[0].port, 'p1');
  const evidenceIds = pruning[0].evidence.map((e) => e.id);
  assert.ok(evidenceIds.includes('j1'), '证据应包含建立成员关系的 Report 事件');
});

test('审计器：检测路由器端口迁移后的误剪枝', () => {
  const ws = makeWorkspace();
  runEvents({
    events: [
      { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
      { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
      { tick: 5, id: 'r1', type: 'router-port-del', port: 'p0' },
      { tick: 5, id: 'r2', type: 'router-port-add', port: 'p9' },
    ],
    statePath: ws.statePath,
    decisionsPath: ws.decisionsPath,
    eventsLogPath: ws.eventsLogPath,
    config: TEST_CONFIG,
    horizon: 7,
  });
  const decisions = readJsonl(ws.decisionsPath);
  const key = keyOf(G, S1);
  // 注入 bug：迁移后流量仍发往旧路由器端口 p0，且漏掉新端口 p9
  decisions[5].flows[key] = ['p0', 'p1'];
  const findings = audit({
    events: readJsonl(ws.eventsLogPath),
    decisions,
    state: readState(ws.statePath),
    config: TEST_CONFIG,
  });

  const pruning = findings.find((f) => f.type === 'erroneous-pruning');
  assert.equal(pruning.port, 'p9');
  assert.equal(pruning.tick, 5);
  const flooding = findings.find((f) => f.type === 'erroneous-flooding');
  assert.equal(flooding.port, 'p0');
  assert.equal(flooding.tick, 5);
});

test('审计器：检测错误泛洪并给出证据', () => {
  const { events, decisions, state } = goodRun();
  const key = keyOf(G, S1);
  // 注入 bug：tick 5 向无成员关系的端口 p7 泛洪
  decisions[5].flows[key] = [...decisions[5].flows[key], 'p7'];
  const findings = audit({ events, decisions, state, config: TEST_CONFIG });

  const flooding = findings.filter((f) => f.type === 'erroneous-flooding');
  assert.equal(flooding.length, 1);
  assert.equal(flooding[0].tick, 5);
  assert.equal(flooding[0].group, G);
  assert.equal(flooding[0].source, S1);
  assert.equal(flooding[0].port, 'p7');
});

test('审计器：检测转发决策与状态文件中的重复成员', () => {
  const { events, decisions, state } = goodRun();
  const key = keyOf(G, S1);
  // 注入 bug 1：决策里端口重复
  decisions[1].flows[key] = [...decisions[1].flows[key], 'p1'];
  // 注入 bug 2：状态文件里成员记录重复
  state.members.push({ ...state.members[0] });
  const findings = audit({ events, decisions, state, config: TEST_CONFIG });

  const dups = findings.filter((f) => f.type === 'duplicate-member');
  assert.equal(dups.length, 2);
  assert.ok(dups.every((f) => f.group === G && f.source === S1 && f.port === 'p1'));
  const stateDup = dups.find((f) => f.evidence.some((e) => e.type === 'state-record'));
  assert.ok(stateDup, '应包含状态文件重复成员的证据');
});

test('审计器：重启后丢失成员关系会被判为误剪枝', () => {
  const ws = makeWorkspace();
  runEvents({
    events: [
      { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
      { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
      { tick: 4, id: 'rst', type: 'restart' },
    ],
    statePath: ws.statePath,
    decisionsPath: ws.decisionsPath,
    eventsLogPath: ws.eventsLogPath,
    config: TEST_CONFIG,
    horizon: 6,
  });
  const decisions = readJsonl(ws.decisionsPath);
  // 注入 bug：重启（tick 4）后成员关系丢失，转发流整体消失
  for (const d of decisions) {
    if (d.tick >= 4) d.flows = {};
  }
  const findings = audit({
    events: readJsonl(ws.eventsLogPath),
    decisions,
    state: readState(ws.statePath),
    config: TEST_CONFIG,
  });

  const pruning = findings.filter((f) => f.type === 'erroneous-pruning');
  assert.ok(pruning.length >= 3, 'tick 4..6 的 p1 与路由器端口都应被标记');
  assert.ok(pruning.some((f) => f.port === 'p1' && f.tick === 4));
  assert.ok(pruning.every((f) => f.group === G && f.source === S1));
});
