import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUp, step, duration } from '../check.mjs';

test('up means the origin answered: below 500, or exactly 200 when strict', () => {
  for (const s of [200, 204, 301, 302, 401, 403, 404]) assert.equal(isUp(s), true, String(s));
  for (const s of [0, 500, 502, 503, 520, 521, 522, 523, 524, 525, 526, 530]) assert.equal(isUp(s), false, String(s));
  assert.equal(isUp(200, true), true);
  assert.equal(isUp(503, true), false);
  assert.equal(isUp(302, true), false);
});

test('one bad run does not alert; the second does, once; recovery alerts once', () => {
  let s = step(undefined, false, '2026-11-09T17:15:00Z');
  assert.equal(s.event, null);
  s = step(s.next, false, '2026-11-09T17:20:00Z');
  assert.equal(s.event, 'down');
  for (let i = 0; i < 5; i++) { s = step(s.next, false, '2026-11-09T18:00:00Z'); assert.equal(s.event, null); }
  s = step(s.next, true, '2026-11-09T20:18:00Z');
  assert.equal(s.event, 'up');
  assert.equal(s.downSince, '2026-11-09T17:15:00Z');
  s = step(s.next, true, '2026-11-09T20:23:00Z');
  assert.equal(s.event, null);
});

test('a single-run blip that recovers never alerts at all', () => {
  let s = step(undefined, false, 'a');
  s = step(s.next, true, 'b');
  assert.equal(s.event, null);
});

test('durations read like a person wrote them', () => {
  assert.equal(duration('2026-11-09T17:15:00Z', '2026-11-09T17:40:00Z'), '25 min');
  assert.equal(duration('2026-11-09T17:15:00Z', '2026-11-09T20:18:00Z'), '3 h 3 min');
});

test('targets are https, uniquely named, and none points at a private service', () => {
  const { targets } = JSON.parse(readFileSync(new URL('../targets.json', import.meta.url)));
  assert.ok(targets.length > 0);
  assert.equal(new Set(targets.map((t) => t.name)).size, targets.length);
  for (const t of targets) {
    assert.match(t.url, /^https:\/\/([a-z0-9-]+\.)?octopustechnology\.net\//, t.url);
    assert.doesNotMatch(t.url, /ops|mcp|portainer|:\d+/, t.url);
  }
});
