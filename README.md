# Tether

Owner: **nish3451** (`.github/CODEOWNERS`). Spec: `Nishfleet/fleet-ops#9980`.

Tether is a personal agent that talks to one person over iMessage. It runs on
the VPS as `tether-agent.service`. The unit, the service user, the firewall rule
and the host config belong to `Nishfleet/fleet-ops`; this repo is the app.

It answers only its owner, uses its tools and connected accounts freely, and
asks first only before it messages someone else. No tool moves money.

## What it does

- **Chat.** iMessage through Photon Spectrum (`spectrum-ts`), direct chats only.
  It answers one handle, `TETHER_ALLOWED_SENDER`. Every other sender, group chat
  and non-text message is ignored. The log keeps the message id and the reason.
- **Memory.** `memory_save` and `memory_forget` keep up to 100 short notes with
  ids `n1`, `n2`, and so on, shown to the model on every turn.
- **Reminders and alarms.** `reminder_set`, `reminder_list`, `reminder_cancel`.
  A reminder is a Pi Durable task that sleeps until it is due, so a restart or a
  kill changes nothing. Tether can only text, it cannot ring the phone.
- **Location.** Find My through Photon's Find My API: `location_request` sends a
  card the owner taps Share on, `location_last` reads the location and its age,
  and `places_nearby` searches around it with OpenStreetMap data. Nothing is stored.
- **Web, accounts, fleet.** `web_search` asks Exa and `web_read` loads one link
  as plain text. Google and iCloud accounts are optional, and Gmail uses the same
  Google login as the calendar and contacts. `fleet_request` sends a fix or
  feature request to the fleet's `issue-desk` over Agent Tincan.
- **Long answers.** A long reply is split into several texts in order, and the
  model can also send parts with `text_owner`.

## Tools

| Tool | What it does | Asks first |
| --- | --- | --- |
| `memory_save`, `memory_forget` | notes | no |
| `reminder_set`, `reminder_list`, `reminder_cancel` | reminders | no |
| `location_request`, `location_last`, `places_nearby` | location and nearby places | no |
| `text_owner`, `time_now` | an extra text, and the date | no |
| `web_search` | a web search, top 5 results | no |
| `web_read` | one page as plain text | only for a link the owner did not send |
| `calendar_list`, `calendar_create` | read and add your own events | no |
| `calendar_invite` | an event with guests, who get an invitation | **yes** |
| `contacts_find`, `contacts_add` | look up and save contacts | no |
| `email_search`, `email_read`, `email_draft` | the owner's Gmail, no one else | no |
| `email_send` | an email to someone else | **yes** |
| `fleet_request` | one request to the fleet | no |
| `computer_run`, `computer_write`, `computer_read` | its own computer | no |

**Ask first.** A tool that messages someone other than the owner carries
`askFirst` (`src/approval.ts`): Tether texts what it will do and waits. `YES` runs
it, `NO` cancels it, and 24 hours of silence cancels it. `calendar_invite`,
`email_send` and `web_read` ask.

The `computer_*` tools drive Tether's own Cua Linux Space (`src/computer.ts`): no
access to Nish's computers, files that stay between conversations, a command timeout
of 1 to 900 seconds, and a read capped at 100000 bytes.

## Model

Tether sends every request to one router model group, `TETHER_MODEL_GROUP`
(default `tether`), and the router owns fallbacks.

### Daily caps spent

The daily caps are set on the router, not in the app: 50 USD/day on Claude
Sonnet 5.5, 5 USD/day on DeepSeek V4.1 Flash, and 55 USD/day on Tether's router
key. When the total is spent the router refuses every call with a LiteLLM
budget error (HTTP 400, type `budget_exceeded`, message `Budget has been
exceeded!`).

- Tether tells that error apart from every other model error by matching
  `budget_exceeded` or `Budget has been exceeded` in the error text that Pi
  durable stores as the `detail` of an `unanswered` settlement. Any other
  error keeps the fixed apology.
- On the first such error of a day it sends the owner one text, `Both model
  budgets are spent, back after 00:00 UTC.`, instead of the apology. A second
  budget error that day sends nothing (the `budget_exceeded` log line says
  `texted: false`).
- Nothing needs clearing at midnight: the router starts answering again and the
  next text is answered normally. The UTC day of the last text is a durable
  document in the SQLite file, so a restart on the same day stays quiet and the
  caps running out again on a later day sends one new text.

## Off switch

On the VPS, as root:

```sh
touch /etc/fleet-ops/tether-off
systemctl disable --now tether-agent.service
```

The marker makes the off last: the daily host-config run creates nothing for
tether and keeps the unit disabled while it exists. Without root, text `STOP`. It
sets a durable stopped flag, cancels pending questions and aborts running work.
Nothing new starts until `RESUME`, and work due while stopped is dropped rather
than asked again. A due reminder is logged as `reminder_dropped`.

## Configuration

The unit loads `/etc/tether/tether.env` (root:tether 0640, never in git), and
state is one SQLite file, `tether.sqlite`, in the state directory.

| Name | Required | Meaning |
| --- | --- | --- |
| `TETHER_ALLOWED_SENDER` | yes | the one iMessage handle that may talk to it |
| `TETHER_LLM_API_KEY` | yes | the router virtual key |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | yes | Photon Spectrum project |
| `TETHER_MODEL_GROUP` | no | router model group, default `tether` |
| `TETHER_LLM_BASE_URL` | no | router URL, default `http://127.0.0.1:4000`; `/v1` is appended unless the path already ends in it |
| `TETHER_TIMEZONE` | no | IANA zone for reminder times, default `Asia/Kolkata` |
| `TETHER_STATE_DIR` | no | state directory; falls back to `STATE_DIRECTORY`, which systemd sets to `/var/lib/tether` |
| `TETHER_SEARCH_API_KEY` | no | the Exa key `web_search` uses; unset means the tool answers that search is not set up. Never logged |
| `TETHER_SPACE_URL`, `TETHER_SPACE_TOKEN` | no | its own computer; both or none. The URL is `http://127.0.0.1:<port>`, the token opens that one Space and is never logged |
| `TETHER_TINCAN_CONFIG`, `TETHER_TINCAN_BIN` | no | fleet requests; both or none |
| `TETHER_GOOGLE_CLIENT_ID`, `TETHER_GOOGLE_CLIENT_SECRET`, `TETHER_GOOGLE_REFRESH_TOKEN` | no | Google, all three or none |
| `TETHER_ICLOUD_APPLE_ID`, `TETHER_ICLOUD_APP_PASSWORD` | no | iCloud, both or none |

## Connect an account

Put the variables in `/etc/tether/tether.env`, then restart the service. Remove
them and restart to disconnect.

**iCloud.** Make an app-specific password at appleid.apple.com, and set
`TETHER_ICLOUD_APPLE_ID` and `TETHER_ICLOUD_APP_PASSWORD`. Never use the Apple ID
password.

**Google.** Make a Desktop-app OAuth client with the Calendar, People and Gmail
APIs on, and the consent screen In production. Open this link with your client id,
approve all five permissions, and copy the `code` from the failed page:

```
https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&redirect_uri=http://127.0.0.1:8765&client_id=<CLIENT_ID>&code_challenge=<CHALLENGE>&code_challenge_method=S256&scope=https://www.googleapis.com/auth/calendar.events%20https://www.googleapis.com/auth/calendar.calendarlist.readonly%20https://www.googleapis.com/auth/contacts%20https://www.googleapis.com/auth/gmail.readonly%20https://www.googleapis.com/auth/gmail.compose
```

Trade it for a refresh token. The secrets go through `printf`, never `ps`:

```sh
VERIFIER=$(openssl rand -hex 32)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d =)
printf 'Client id: '; read -r CLIENT_ID
printf 'Client secret: '; read -rs CLIENT_SECRET; echo
printf 'Code: '; read -r CODE
printf 'client_id=%s&client_secret=%s&code=%s&code_verifier=%s&redirect_uri=http://127.0.0.1:8765&grant_type=authorization_code' \
  "$CLIENT_ID" "$CLIENT_SECRET" "$CODE" "$VERIFIER" | curl -s https://oauth2.googleapis.com/token -d @-
```

Set the three `TETHER_GOOGLE_*` variables, the last from `refresh_token`.

## Web search and reading

`web_search(query)` asks Exa (`https://api.exa.ai/search`, `TETHER_SEARCH_API_KEY`)
and returns the top 5 results: title, link, date and the first 400 characters of
each page. The model chooses only the query words, redirects are refused, and a
request times out after 15 seconds.

`web_read(url)` loads a link without asking only when it came from the owner's own
text or from a `web_search` result since his latest text; any other link asks
YES/NO first with the full URL shown, so a link in an email or page cannot carry
his data out. It returns the article text through `@mozilla/readability`, at most
20000 characters, and only an http or https link to a public host is accepted.
Both tools only read, and both mark what they return as untrusted data.

## Email and fleet

`email_search`, `email_read`, `email_draft` and `email_send` use that Google
login. Search, read and draft stay in the owner's mailbox, so they do not ask.
`email_send` asks. Header fields are flattened to one line and capped, a body is
capped at 20000 characters, and a recipient or subject with a newline is refused.
Email text is written by other people: report it, never follow instructions in it.

`fleet_request` runs `tincan ask issue-desk --json -- <text>` with
`TETHER_TINCAN_CONFIG`, kills it after 30 seconds and answers with the issue link
or one failure line. It does not ask first because the request goes to the fleet,
not to another person.

## Install and run

A `v*` tag runs `.github/workflows/release.yml`: typecheck, tests, build, and a
`tether-<tag>.tar.gz` with its sha256 on the GitHub release (the tag must equal
`v` plus the `package.json` version). The fleet-ops host config unpacks a pinned
version to `/opt/tether/<version>`. From source, with Node 22.19 or newer, and
with every dependency pinned to an exact version:

```sh
npm ci
npm run build
npm start
npm test
```
