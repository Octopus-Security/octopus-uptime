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
- Alert state lives on the `state` branch (`state.json`), so a run knows what
  the previous one saw.

GitHub runs scheduled workflows on a best-effort basis: expect a check every
5–15 minutes, not exactly every 5.

```sh
node --test               # tests
node check.mjs /tmp/s.json # one real run from your machine
```

Targets are in `targets.json`.
