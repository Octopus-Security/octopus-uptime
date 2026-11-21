// Minimal SMTP client, zero dependencies (this repo has no package.json and the
// workflow runs plain `node`). Port 465 = implicit TLS; anything else = plain connect
// then STARTTLS, which is required before AUTH. Used by check.mjs for the optional
// email alert. Never logs credentials or the message.
import net from 'node:net';
import tls from 'node:tls';

export function emailConfig(env = process.env) {
  const c = {
    host: (env.SMTP_HOST || '').trim(),
    port: Number(env.SMTP_PORT) > 0 ? Number(env.SMTP_PORT) : 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    to: (env.ALERT_EMAIL_TO || '').trim(),
    from: (env.MAIL_FROM || '').trim(),
  };
  return c.host && c.to && c.from ? c : null; // any of the three missing = email off, silently
}

const addr = (s) => (/<([^>]+)>/.exec(s) || [null, s])[1].trim();
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ');

export function buildMessage({ from, to, subject, text }) {
  const body = text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return [
    `From: ${clean(from)}`, `To: ${clean(to)}`, `Subject: ${clean(subject).slice(0, 200)}`,
    `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit', '', body, '',
  ].join('\r\n');
}

/** Reads SMTP replies (multi-line aware) off a socket; swap() re-points it after STARTTLS. */
function reader(sock) {
  let buf = '';
  const waiting = [];
  const pump = () => {
    for (;;) {
      const m = /^(?:\d{3}-.*\r?\n)*\d{3} .*\r?\n/.exec(buf);
      if (!m || !waiting.length) return;
      buf = buf.slice(m[0].length);
      waiting.shift()(m[0]);
    }
  };
  const attach = (s) => { s.on('data', (d) => { buf += d.toString('utf8'); pump(); }); };
  attach(sock);
  return {
    next: (ms = 15000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('smtp timeout')), ms);
      waiting.push((r) => { clearTimeout(t); res(r); });
      pump();
    }),
    attach,
  };
}

/** sendMail({host,port,user,pass,from,to,subject,text}, {allowPlain}) -> resolves or throws (message never contains the password). */
export async function sendMail(c, { allowPlain = false } = {}) {
  const implicit = c.port === 465;
  let sock = await new Promise((res, rej) => {
    const s = implicit
      ? tls.connect({ host: c.host, port: c.port, servername: c.host }, () => res(s))
      : net.connect({ host: c.host, port: c.port }, () => res(s));
    s.once('error', rej);
    s.setTimeout(20000, () => s.destroy(new Error('smtp socket timeout')));
  });
  sock.on('error', () => {});
  const rd = reader(sock);
  const cmd = async (line, ok) => {
    sock.write(line + '\r\n');
    const r = await rd.next();
    if (!ok.test(r)) throw new Error(`smtp: unexpected reply to ${line.split(' ')[0]}: ${r.slice(0, 3)}`);
    return r;
  };
  try {
    const hello = await rd.next();
    if (!hello.startsWith('220')) throw new Error('smtp: bad greeting');
    let ehlo = await cmd('EHLO octopus-uptime', /^250/);
    let secure = implicit;
    if (!implicit && /STARTTLS/i.test(ehlo)) {
      await cmd('STARTTLS', /^220/);
      sock = tls.connect({ socket: sock, servername: c.host });
      sock.on('error', () => {});
      rd.attach(sock);
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      ehlo = await cmd('EHLO octopus-uptime', /^250/);
      secure = true;
    }
    if (c.user) {
      if (!secure && !allowPlain) throw new Error('smtp: refusing to send credentials without TLS');
      const tok = Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64');
      await cmd(`AUTH PLAIN ${tok}`, /^235/);
    }
    await cmd(`MAIL FROM:<${addr(c.from)}>`, /^250/);
    for (const r of c.to.split(',').map((x) => x.trim()).filter(Boolean)) await cmd(`RCPT TO:<${addr(r)}>`, /^25[01]/);
    await cmd('DATA', /^354/);
    sock.write(buildMessage(c) + '.\r\n');
    const done = await rd.next();
    if (!done.startsWith('250')) throw new Error('smtp: message rejected');
    sock.write('QUIT\r\n');
  } finally { sock.destroy(); }
}
