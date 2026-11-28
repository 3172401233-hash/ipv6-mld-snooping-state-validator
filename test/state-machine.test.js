import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvents } from '../src/runner.js';
import { audit } from '../src/auditor.js';
import { MldSnoopingStateMachine } from '../src/state-machine.js';
import { G, S1, S2, TEST_CONFIG, keyOf, makeWorkspace, readJsonl, readState } from './helpers.js';

function run(ws, events, horizon) {
  return runEvents({
    events,
    statePath: ws.statePath,
    decisionsPath: ws.decisionsPath,
    eventsLogPath: ws.eventsLogPath,
    config: TEST_CONFIG,
    horizon,
  });
}

function auditWorkspace(ws) {
  return audit({
    events: readJsonl(ws.eventsLogPath),
    decisions: readJsonl(ws.decisionsPath),
    state: readState(ws.statePath),
    config: TEST_CONFIG,
  });
}

test('快速 Leave/Report：last-listener 窗口内的新 Report 阻止提前剪枝', () => {
  const ws = makeWorkspace();
  const { decisions } = run(ws, [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
    { tick: 2, id: 'l1', type: 'done', port: 'p1', group: G, sources: [S1] },
    { tick: 3, id: 'j2', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
  ], 8);

  const key = keyOf(G, S1);
  for (let t = 1; t <= 8; t++) {
    assert.ok(decisions[t].flows[key]?.includes('p1'), `tick ${t} 不应剪枝 p1`);
  }
  // Done 触发了组特定查询（仿真动作，不发送真实报文）
  assert.equal(decisions[2].queries.length, 1);
  assert.equal(decisions[2].queries[0].type, 'group-source-specific-query');
  // 路由器端口 p0 在 routerPortTimer=8 到期后不再出现
  assert.deepEqual(decisions[8].flows[key], ['p1']);
  assert.deepEqual(auditWorkspace(ws), []);
});

test('Leave 后无新 Report：last-listener 窗口到期后才剪枝', () => {
  const ws = makeWorkspace();
  const { decisions } = run(ws, [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
    { tick: 2, id: 'l1', type: 'done', port: 'p1', group: G, sources: [S1] },
  ], 6);

  const key = keyOf(G, S1);
  // leaveWindow = 2：tick 2、3 仍转发，tick 4 起剪枝
  assert.ok(decisions[2].flows[key].includes('p1'));
  assert.ok(decisions[3].flows[key].includes('p1'));
  assert.equal(decisions[4].flows[key], undefined);
  assert.deepEqual(auditWorkspace(ws), []);
});

test('路由器端口迁移：转发集合同 tick 切换到新路由器端口', () => {
  const ws = makeWorkspace();
  const { decisions } = run(ws, [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
    { tick: 5, id: 'r1', type: 'router-port-del', port: 'p0' },
    { tick: 5, id: 'r2', type: 'router-port-add', port: 'p9' },
  ], 7);

  const key = keyOf(G, S1);
  assert.deepEqual(decisions[4].flows[key], ['p0', 'p1']);
  assert.deepEqual(decisions[5].flows[key], ['p1', 'p9']);
  assert.deepEqual(decisions[6].flows[key], ['p1', 'p9']);
  assert.deepEqual(auditWorkspace(ws), []);
});

test('进程重启：从状态文件恢复后转发决策与不重启完全一致', () => {
  const events = (withRestart) => [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
    ...(withRestart ? [{ tick: 4, id: 'rst', type: 'restart' }] : []),
  ];
  const wsA = makeWorkspace();
  const wsB = makeWorkspace();
  const runA = run(wsA, events(true), 7);
  const runB = run(wsB, events(false), 7);

  assert.equal(runA.decisions.length, runB.decisions.length);
  for (let t = 0; t < runA.decisions.length; t++) {
    assert.deepEqual(runA.decisions[t].flows, runB.decisions[t].flows, `tick ${t} 转发不一致`);
  }
  // 重启后成员关系与定时器从状态文件恢复
  const wsC = makeWorkspace();
  run(wsC, [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] },
    { tick: 2, id: 'rst', type: 'restart' },
  ], 3);
  const sm = MldSnoopingStateMachine.load(wsC.statePath);
  const member = [...sm.members.values()].find((m) => m.port === 'p1');
  assert.ok(member, '重启后成员关系应保留');
  assert.equal(member.state, 'active');
  assert.equal(member.expiresAt, 1 + TEST_CONFIG.groupTimer);
  assert.deepEqual(auditWorkspace(wsA), []);
});

test('重复事件：相同 id 的事件被去重，不产生重复成员', () => {
  const ws = makeWorkspace();
  const join = { tick: 1, id: 'dup', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1] };
  const events = [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    join,
    { ...join },
    { ...join, tick: 2 },
  ];
  const first = run(ws, events, 4);
  assert.equal(first.stateMachine.members.size, 1);
  assert.equal(first.appliedEvents.filter((e) => e.id === 'dup').length, 1);

  // 用同一状态文件重放整段事件（模拟重启后重放）：仍然只有一个成员
  const second = run(ws, events, 4);
  assert.equal(second.stateMachine.members.size, 1);
  assert.equal(second.appliedEvents.length, 0);

  for (const d of first.decisions) {
    for (const ports of Object.values(d.flows)) {
      assert.equal(new Set(ports).size, ports.length, '转发端口集合不得有重复');
    }
  }
  assert.deepEqual(auditWorkspace(ws), []);
});

test('源特定组播：按源独立维护成员关系与剪枝', () => {
  const ws = makeWorkspace();
  const { decisions } = run(ws, [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'include', sources: [S1, S2] },
    { tick: 3, id: 'l1', type: 'done', port: 'p1', group: G, sources: [S1] },
  ], 8);

  const k1 = keyOf(G, S1);
  const k2 = keyOf(G, S2);
  // S1 在窗口期（tick 3、4）仍转发，tick 5 剪枝
  assert.ok(decisions[3].flows[k1].includes('p1'));
  assert.ok(decisions[4].flows[k1].includes('p1'));
  assert.equal(decisions[5].flows[k1], undefined);
  // S2 不受影响，直到 groupTimer 到期（1+6=7）
  assert.ok(decisions[6].flows[k2].includes('p1'));
  assert.equal(decisions[7].flows[k2], undefined);
  assert.deepEqual(auditWorkspace(ws), []);
});

test('ASM exclude 模式：通配源成员接收所有源的流量', () => {
  const ws = makeWorkspace();
  const { decisions } = run(ws, [
    { tick: 0, id: 'r0', type: 'router-port-add', port: 'p0' },
    { tick: 1, id: 'j1', type: 'report', port: 'p1', group: G, mode: 'exclude', sources: [] },
    { tick: 2, id: 'j2', type: 'report', port: 'p2', group: G, mode: 'include', sources: [S1] },
    { tick: 4, id: 'l1', type: 'done', port: 'p1', group: G },
  ], 8);

  const wild = keyOf(G, '*');
  const k1 = keyOf(G, S1);
  assert.deepEqual(decisions[2].flows[wild], ['p0', 'p1']);
  assert.deepEqual(decisions[2].flows[k1], ['p0', 'p1', 'p2']);
  // p1 的 Done 只影响通配成员；窗口期后 G|* 消失，G|S1 只剩 p2
  assert.equal(decisions[6].flows[wild], undefined);
  assert.deepEqual(decisions[6].flows[k1], ['p0', 'p2']);
  assert.deepEqual(auditWorkspace(ws), []);
});
