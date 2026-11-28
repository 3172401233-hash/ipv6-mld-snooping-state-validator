import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const G = 'ff3e::1';
export const S1 = '2001:db8::10';
export const S2 = '2001:db8::20';

export const TEST_CONFIG = {
  groupTimer: 6,
  lastListenerInterval: 1,
  lastListenerCount: 2,
  routerPortTimer: 8,
};

export function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mld-snoop-'));
  return {
    dir,
    statePath: join(dir, 'state.json'),
    decisionsPath: join(dir, 'decisions.jsonl'),
    eventsLogPath: join(dir, 'events.jsonl'),
  };
}

export function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function readState(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export const keyOf = (group, source) => `${group}|${source}`;
