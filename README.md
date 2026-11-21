# octopus-uptime

An outside check that the Octopus Technology sites are answering. It runs on
GitHub Actions every few minutes, so it keeps working when the server, or the
service that sends every other alert, is the thing that is down.

- **Up** means the site answered with a status below 500. A login redirect,
  401 or 404 still proves the app is running. Cloudflare's 502, 520–526 and
  530, and no answer at all, mean it is down. Targets marked `strict` must answer
  exactly 200 (used for the chat bots' health check, which returns 503 when a bot is offline).
- A target that fails is retried once, 20 seconds later.
- **It alerts once** when a target has failed two runs in a row, and once when
  it comes back, with how long it was down. A restart during a deploy that
  lasts one run never alerts.
- Alerts go to a Discord webhook and/or Telegram, whichever is configured
  (repository secrets `DISCORD_WEBHOOK_URL`, or `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID`). With neither, the run that finds a new outage fails, and
  GitHub's failed-run email is the alert.
- **Email** is a third optional channel, sent on the same events (one email per
  outage, one on recovery). It is skipped silently unless the repository secrets
  `SMTP_HOST`, `ALERT_EMAIL_TO` and `MAIL_FROM` are all set; also `SMTP_USER`,
  `SMTP_PASS` and `SMTP_PORT` (465 = implicit TLS, default; 587 = STARTTLS;
  credentials are never sent without TLS). Migadu: `smtp.migadu.com`. The SMTP
  client is `mail.mjs`, dependency-free, so no third-party action touches the secrets.
  Telegram needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (create a bot with
  BotFather; the chat id is from messaging the bot and reading `getUpdates`); both
  are already wired in the workflow, they just are not set yet.
- Alert state lives on the `state` branch (`state.json`), so a run knows what
  the previous one saw.

GitHub runs scheduled workflows on a best-effort basis: expect a check every
5–15 minutes, not exactly every 5.

```sh
node --test               # tests
node check.mjs /tmp/s.json # one real run from your machine
```

Targets are in `targets.json`.
