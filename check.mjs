// octopus-uptime: check every target, alert ONCE when one goes down and once
// when it comes back. Runs from GitHub Actions, off the server, so it still
// works when the server (and cortex, which sends every other alert) is down.
//
//   node check.mjs [stateFile]        state defaults to state/state.json
//
// Env (all optional):
//   DISCORD_WEBHOOK_URL                       post alerts to a Discord channel
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID     send alerts via the Telegram Bot API
//   SMTP_HOST + ALERT_EMAIL_TO + MAIL_FROM    email alerts (+ SMTP_PORT, SMTP_USER, SMTP_PASS);
//                                             skipped silently unless all three are set
//   FAIL_RUNS   consecutive failing runs before alerting (default 2: a deploy
//               restart that lasts one run never pages anyone)
//
// Exit 1 on a NEW outage (and on an alert that could not be delivered), so
// GitHub's own failed-run email is the fallback when no channel is set.
// Steady state, down or up, exits 0: one email per outage, not one per run.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { emailConfig, sendMail } from './mail.mjs';

/** Up = answered below 500 (strict: exactly 200). No answer = down. */
export function isUp(status, strict = false) {
  if (!status) return false;
  return strict ? status === 200 : status < 500;
}

/**
 * Pure transition step for one target.
 * prev: { failRuns, alerted, since } | undefined ; up: boolean
 * -> { next, event: null | 'down' | 'up' }
 */
export function step(prev, up, nowIso, failRunsNeeded = 2) {
  const p = prev || { failRuns: 0, alerted: false, since: null };
  if (up) {
    const event = p.alerted ? 'up' : null;
    return { next: { failRuns: 0, alerted: false, since: null }, event, downSince: p.since };
  }
  const next = { failRuns: p.failRuns + 1, alerted: p.alerted, since: p.since || nowIso };
  if (!p.alerted && next.failRuns >= failRunsNeeded) {
    next.alerted = true;
    return { next, event: 'down' };
  }
  return { next, event: null };
}

/**
 * A target may take its URL and headers from environment variables (repository
 * secrets) instead of targets.json, which is public. Returns null when any of
 * them is unset, so a target nobody has configured yet is reported, not probed.
 * `label` is what logs and alerts print in place of the URL.
 */
/** The public-target rule: https on our own domain, never a private service or a bare port. */
export function allowedUrl(url) {
  return /^https:\/\/([a-z0-9-]+\.)?octopustechnology\.net\//.test(url) && !/ops|mcp|portainer|:\d+/.test(url);
}

export function resolveTarget(t, env = process.env) {
  const url = t.urlEnv ? env[t.urlEnv] : t.url;
  if (!url || (t.urlEnv && !allowedUrl(url))) return null;
  const headers = {};
  for (const [h, name] of Object.entries(t.headersEnv || {})) {
    if (!env[name]) return null;
    headers[h] = env[name];
  }
  return { url, headers, label: t.urlEnv ? `(secret ${t.urlEnv})` : t.url };
}

export function duration(fromIso, toIso) {
  const m = Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function probe(url, headers = {}) {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'octopus-uptime', ...headers } });
    return { status: r.status };
  } catch (e) {
    return { status: 0, error: e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code || e.message) };
  }
}

async function checkTarget(t) {
  let r = await probe(t.resolved.url, t.resolved.headers);
  if (!isUp(r.status, t.strict)) {
    await new Promise((res) => setTimeout(res, 20000)); // one retry: ride out a blip
    r = await probe(t.resolved.url, t.resolved.headers);
  }
  return { ...r, up: isUp(r.status, t.strict) };
}

async function notify(text) {
  const sent = [];
  const errors = [];
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      const r = await fetch(process.env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) });
      if (r.ok) sent.push('discord'); else errors.push(`discord ${r.status}`);
    } catch (e) { errors.push(`discord ${e.message}`); }
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
      });
      if (r.ok) sent.push('telegram'); else errors.push(`telegram ${r.status}`);
    } catch (e) { errors.push(`telegram ${e.message}`); }
  }
  const mail = emailConfig();
  if (mail) {
    try {
      const first = text.split('\n').find((l) => l.trim() && !l.startsWith('[octopus-uptime]')) || 'alert';
      await sendMail({ ...mail, subject: `[octopus-uptime] ${first}`.slice(0, 160), text });
      sent.push('email');
    } catch (e) { errors.push(`email ${String(e.message).replace(mail.pass || '\u0000', '***')}`); }
  }
  return { sent, errors };
}

async function main() {
  const stateFile = process.argv[2] || 'state/state.json';
  const all = JSON.parse(readFileSync(new URL('./targets.json', import.meta.url))).targets;
  const targets = [];
  for (const t of all) {
    const resolved = resolveTarget(t);
    // Loud, every run: an unconfigured check must not look like a passing one.
    if (!resolved) { console.log(`SKIP  ${t.name.padEnd(12)} not configured: set the repository secrets ${[t.urlEnv, ...Object.values(t.headersEnv || {})].filter(Boolean).join(', ')}`); continue; }
    targets.push({ ...t, resolved });
  }
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { targets: {} };
  const need = Math.max(1, parseInt(process.env.FAIL_RUNS || '2', 10));
  const now = new Date().toISOString();

  const results = await Promise.all(targets.map(checkTarget));
  const downs = [];
  const ups = [];
  const nextTargets = {};
  targets.forEach((t, i) => {
    const r = results[i];
    const s = step(state.targets[t.name], r.up, now, need);
    nextTargets[t.name] = s.next;
    const why = r.status ? `HTTP ${r.status}` : r.error;
    console.log(`${r.up ? 'up  ' : 'DOWN'}  ${t.name.padEnd(12)} ${why}${!r.up ? ` (failing runs: ${s.next.failRuns})` : ''}`);
    if (s.event === 'down') downs.push(`${t.name}: ${why} — ${t.resolved.label}${t.note ? `\n  ${t.note}` : ''}`);
    if (s.event === 'up') ups.push(`${t.name} (down ${duration(s.downSince, now)})`);
  });

  let failed = false;
  const lines = [];
  if (downs.length) lines.push(`🔴 DOWN\n${downs.join('\n')}`);
  if (ups.length) lines.push(`🟢 Back up: ${ups.join(', ')}`);
  if (lines.length) {
    const { sent, errors } = await notify(`[octopus-uptime]\n${lines.join('\n\n')}`);
    console.log(`alert: sent to ${sent.join(', ') || 'no channel'}${errors.length ? `; FAILED ${errors.join('; ')}` : ''}`);
    if (errors.length) failed = true;
  }
  if (downs.length) failed = true;

  const changed = JSON.stringify(nextTargets) !== JSON.stringify(state.targets) || state.day !== now.slice(0, 10);
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ day: now.slice(0, 10), checkedAt: now, targets: nextTargets }, null, 2) + '\n');
  console.log(changed ? 'state: changed' : 'state: unchanged');
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: 'a' });
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
