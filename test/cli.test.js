import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWorkspace, readJsonl } from './helpers.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, 'src', 'cli.js');
const exampleEvents = join(repoRoot, 'examples', 'events.json');

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('CLI：run + audit 示例事件脚本（含迁移/重启/快速 Leave-Report）', () => {
  const ws = makeWorkspace();
  const run = runCli([
    'run',
    '--events', exampleEvents,
    '--state', ws.statePath,
    '--decisions', ws.decisionsPath,
    '--events-log', ws.eventsLogPath,
    '--horizon', '12',
  ]);
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.appliedEvents, 9);
  assert.deepEqual(summary.ticks, [0, 12]);

  const audit = runCli([
    'audit',
    '--state', ws.statePath,
    '--decisions', ws.decisionsPath,
    '--events-log', ws.eventsLogPath,
  ]);
  assert.equal(audit.status, 0, audit.stderr);
  const report = JSON.parse(audit.stdout);
  assert.deepEqual(report.findings, []);
});

test('CLI：audit 发现注入的误剪枝时以退出码 1 结束', () => {
  const ws = makeWorkspace();
  const run = runCli([
    'run',
    '--events', exampleEvents,
    '--state', ws.statePath,
    '--decisions', ws.decisionsPath,
    '--events-log', ws.eventsLogPath,
    '--horizon', '12',
  ]);
  assert.equal(run.status, 0, run.stderr);

  // 破坏决策日志：tick 2 删掉监听端口 ge-0/0/1
  const decisions = readJsonl(ws.decisionsPath);
  const target = decisions.find((d) => d.tick === 2);
  const key = 'ff3e::100|2001:db8::1';
  target.flows[key] = target.flows[key].filter((p) => p !== 'ge-0/0/1');
  writeFileSync(ws.decisionsPath, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');

  const audit = runCli([
    'audit',
    '--state', ws.statePath,
    '--decisions', ws.decisionsPath,
    '--events-log', ws.eventsLogPath,
  ]);
  assert.equal(audit.status, 1);
  const report = JSON.parse(audit.stdout);
  const pruning = report.findings.find((f) => f.type === 'erroneous-pruning');
  assert.equal(pruning.port, 'ge-0/0/1');
  assert.equal(pruning.group, 'ff3e::100');
  assert.equal(pruning.source, '2001:db8::1');
  assert.ok(pruning.evidence.some((e) => e.id === 'host1-join'));
  assert.ok(readFileSync(ws.statePath, 'utf8').length > 0);
});
