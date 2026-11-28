#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { runEvents } from './runner.js';
import { audit } from './auditor.js';

const USAGE = `用法:
  node src/cli.js run   --events <events.json> [--state state.json]
                        [--decisions decisions.jsonl] [--events-log events.jsonl]
                        [--config config.json] [--horizon N]
  node src/cli.js audit [--state state.json] [--decisions decisions.jsonl]
                        [--events-log events.jsonl] [--config config.json]

纯仿真工具：不发送/接收真实 MLD 报文，所有输入均为 JSON 事件。
audit 在发现问题时以退出码 1 结束。`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (command === 'run') {
  if (!args.events) {
    console.error(USAGE);
    process.exit(2);
  }
  const events = JSON.parse(readFileSync(args.events, 'utf8'));
  const config = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : {};
  const statePath = args.state ?? 'artifacts/state.json';
  const decisionsPath = args.decisions ?? 'artifacts/decisions.jsonl';
  const eventsLogPath = args['events-log'] ?? 'artifacts/events.jsonl';
  const horizon = args.horizon != null ? Number(args.horizon) : null;
  const { stateMachine, decisions, appliedEvents } = runEvents({
    events,
    statePath,
    decisionsPath,
    eventsLogPath,
    config,
    horizon,
  });
  console.log(
    JSON.stringify({
      appliedEvents: appliedEvents.length,
      skippedEvents: events.length - appliedEvents.length,
      ticks: decisions.length ? [decisions[0].tick, decisions[decisions.length - 1].tick] : [],
      members: stateMachine.members.size,
      routerPorts: [...stateMachine.routerPorts.keys()],
      statePath,
      decisionsPath,
      eventsLogPath,
    }, null, 2),
  );
} else if (command === 'audit') {
  const statePath = args.state ?? 'artifacts/state.json';
  const decisionsPath = args.decisions ?? 'artifacts/decisions.jsonl';
  const eventsLogPath = args['events-log'] ?? 'artifacts/events.jsonl';
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const decisions = readJsonl(decisionsPath);
  const events = readJsonl(eventsLogPath);
  const config = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : (state.config ?? {});
  const findings = audit({ events, decisions, state, config });
  console.log(JSON.stringify({ findings, counts: countByType(findings) }, null, 2));
  if (findings.length > 0) process.exit(1);
} else {
  console.error(USAGE);
  process.exit(2);
}

function countByType(findings) {
  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return counts;
}
