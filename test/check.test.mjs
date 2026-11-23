import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUp, step, duration, resolveTarget, allowedUrl } from '../check.mjs';

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
    if (t.urlEnv) continue; // secret URLs are held to the same rule when resolved (allowedUrl)
    assert.match(t.url, /^https:\/\/([a-z0-9-]+\.)?octopustechnology\.net\//, t.url);
    assert.doesNotMatch(t.url, /ops|mcp|portainer|:\d+/, t.url);
    assert.ok(allowedUrl(t.url), t.url);
  }
});

import net from 'node:net';
import { emailConfig, sendMail, buildMessage } from '../mail.mjs';

test('email is off unless host, recipient and from are all set', () => {
  assert.equal(emailConfig({}), null);
  assert.equal(emailConfig({ SMTP_HOST: 'h', ALERT_EMAIL_TO: 'a@b.c' }), null);
  assert.equal(emailConfig({ SMTP_HOST: 'h', MAIL_FROM: 'x@y.z' }), null);
  const c = emailConfig({ SMTP_HOST: 'h', ALERT_EMAIL_TO: 'a@b.c', MAIL_FROM: 'x@y.z' });
  assert.equal(c.port, 465);
});

test('message headers cannot be injected and dot-lines are escaped', () => {
  const m = buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'hi\r\nBcc: evil@x.y', text: 'line\n.dot\n' });
  assert.ok(!/^Bcc:/m.test(m));
  assert.ok(m.includes('\r\n..dot'));
});

test('sends over SMTP once with the right envelope, and never puts the password in an error', async () => {
  const got = [];
  const srv = net.createServer((s) => {
    s.write('220 hi\r\n');
    let data = false; let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); got.push(line);
        if (data) { if (line === '.') { data = false; s.write('250 ok\r\n'); } continue; }
        if (line.startsWith('EHLO')) s.write('250 hi\r\n');
        else if (line.startsWith('AUTH')) s.write('535 no\r\n');
        else if (line === 'DATA') { data = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = { host: '127.0.0.1', port: srv.address().port, from: 'Alerts <a@b.c>', to: 'o@e.f', subject: 'down', text: 'site is down' };
  await sendMail(base);
  assert.ok(got.includes('MAIL FROM:<a@b.c>') && got.includes('RCPT TO:<o@e.f>'));
  assert.ok(got.includes('site is down'));
  await assert.rejects(sendMail({ ...base, user: 'u', pass: 'hunter2-pass' }), /without TLS/);
  await assert.rejects(sendMail({ ...base, user: 'u', pass: 'hunter2-pass' }, { allowPlain: true }), (e) => !e.message.includes('hunter2-pass') && /AUTH/.test(e.message));
  srv.close();
});

test('a secret-backed target resolves from env, is skipped until configured, and never prints its URL', () => {
  const t = { name: 'ids', urlEnv: 'IDS_URL', headersEnv: { 'x-ids-token': 'IDS_TOKEN' }, strict: true };
  assert.equal(resolveTarget(t, {}), null);
  assert.equal(resolveTarget(t, { IDS_URL: 'https://h/heartbeat' }), null, 'a missing header secret also skips');
  const r = resolveTarget(t, { IDS_URL: 'https://ids.octopustechnology.net/heartbeat', IDS_TOKEN: 'tok' });
  assert.deepEqual(r, { url: 'https://ids.octopustechnology.net/heartbeat', headers: { 'x-ids-token': 'tok' }, label: '(secret IDS_URL)' });
  assert.equal(resolveTarget(t, { IDS_URL: 'http://1.2.3.4:9471/heartbeat', IDS_TOKEN: 'tok' }), null, 'a secret URL obeys the public-target rule');
  assert.equal(resolveTarget({ name: 'site', url: 'https://x/' }, {}).label, 'https://x/');
});

test('targets.json is valid and the heartbeat target holds no URL or token in the public file', () => {
  const { targets } = JSON.parse(readFileSync(new URL('../targets.json', import.meta.url)));
  const ids = targets.find((t) => t.name === 'ids heartbeat');
  assert.ok(ids && ids.strict && ids.urlEnv && !ids.url);
  for (const t of targets) assert.ok(t.url || t.urlEnv, t.name);
});
