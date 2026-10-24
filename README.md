# Tether

Owner: **nish3451** (`.github/CODEOWNERS`). Spec: `Nishfleet/fleet-ops#9980`.

Tether is a personal agent that talks to one person over iMessage. It runs on
the VPS as `tether-agent.service`. The unit, the service user, the firewall rule
and the host config belong to `Nishfleet/fleet-ops`; this repo is the app.

It answers only its owner, uses its tools and connected accounts freely, and
asks first only before it messages someone else. No tool can move money.

## What it does

- **Chat.** iMessage through Photon Spectrum (`spectrum-ts`), direct chats only.
  It answers one handle, `TETHER_ALLOWED_SENDER`. Every other sender, group chat
  and non-text message is ignored. The log keeps the message id and the reason.
- **Memory.** `memory_save` and `memory_forget` keep up to 100 short notes with
  ids `n1`, `n2`, and so on. The notes are shown to the model on every turn.
- **Reminders and alarms.** `reminder_set`, `reminder_list`, `reminder_cancel`.
  A reminder is a Pi Durable task that sleeps until it is due, so a restart or a
  kill changes nothing. Tether can only text, it cannot ring the phone.
- **Location.** Find My through Photon's Find My API. `location_request` sends a
  card the owner taps Share on, `location_last` reads the location and its age,
  and `places_nearby` searches around it with OpenStreetMap data. Nothing is
  stored and coordinates are never logged.
- **Calendar, contacts and email.** Google and iCloud, each optional. Gmail uses
  the same Google login. See below.
- **Fleet requests.** `fleet_request` sends a fix or feature request to the
  fleet's `issue-desk` over Agent Tincan.
- **Its own computer.** A Cua Linux Space on the server, see below.
- **Long answers.** A long reply is split into several texts in order. The model
  can also send parts with `text_owner`. `time_now` gives the date.

## Tools

| Tool | What it does | Asks first |
| --- | --- | --- |
| `memory_save`, `memory_forget` | notes | no |
| `reminder_set`, `reminder_list`, `reminder_cancel` | reminders | no |
| `location_request`, `location_last`, `places_nearby` | location and nearby places | no |
| `text_owner`, `time_now` | an extra text, and the date | no |
| `calendar_list`, `calendar_create` | read and add your own events | no |
| `calendar_invite` | an event with guests, who get an invitation | **yes** |
| `contacts_find`, `contacts_add` | look up and save contacts | no |
| `email_search`, `email_read`, `email_draft` | the owner's Gmail, no one else | no |
| `email_send` | an email to someone else | **yes** |
| `fleet_request` | one request to the fleet | no |
| `computer_run`, `computer_write`, `computer_read` | its own computer | no |

**Ask first.** A tool that messages someone other than the owner carries
`askFirst` (`src/approval.ts`). Before it runs, Tether texts what it is about to
do and waits. `YES` runs it, `NO` cancels it, and no answer in 24 hours cancels
it. One question is asked at a time, and the wait survives a restart. Today
`calendar_invite` and `email_send` ask. A new tool that messages other people
must set `askFirst`.

## Model

Tether talks to an OpenAI-compatible router (`TETHER_LLM_BASE_URL`, default
`http://127.0.0.1:4000`, `/v1` is appended). Every request goes to one model
group, `TETHER_MODEL_GROUP` (default `tether`). The router owns fallbacks, and
Tether does not look at which model answered.

## Off switch

On the VPS, as root:

```sh
touch /etc/fleet-ops/tether-off
systemctl disable --now tether-agent.service
```

Without root, text `STOP`. It sets a durable stopped flag, cancels pending
questions and aborts running work. Nothing new starts until `RESUME` (a send
already handed to iMessage can still arrive). Work due while stopped is dropped,
not asked again, and a due reminder is logged as `reminder_dropped`.

## Configuration

The unit loads `/etc/tether/tether.env` (root:tether 0640, never in git).

| Name | Required | Meaning |
| --- | --- | --- |
| `TETHER_ALLOWED_SENDER` | yes | the one iMessage handle that may talk to it |
| `TETHER_LLM_API_KEY` | yes | the router key |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | yes | Photon Spectrum project |
| `TETHER_MODEL_GROUP` | no | router model group, default `tether` |
| `TETHER_LLM_BASE_URL` | no | router URL, default `http://127.0.0.1:4000` |
| `TETHER_TIMEZONE` | no | IANA zone, default `Asia/Kolkata` |
| `TETHER_STATE_DIR` | no | state directory, falls back to `/var/lib/tether` |
| `TETHER_SPACE_URL`, `TETHER_SPACE_TOKEN` | no | its own computer; both or none |
| `TETHER_GOOGLE_CLIENT_ID`, `TETHER_GOOGLE_CLIENT_SECRET`, `TETHER_GOOGLE_REFRESH_TOKEN` | no | Google, all three or none |
| `TETHER_ICLOUD_APPLE_ID`, `TETHER_ICLOUD_APP_PASSWORD` | no | iCloud, both or none |
| `TETHER_TINCAN_CONFIG`, `TETHER_TINCAN_BIN` | no | fleet requests; both or none |

State is one SQLite file, `tether.sqlite`, in the state directory. A half-set account stops the start with an error that names the missing variables.

## Connect an account

Put the variables in `/etc/tether/tether.env`, then restart the service. Remove
them and restart to disconnect.

**iCloud.** Make an app-specific password at appleid.apple.com and set
`TETHER_ICLOUD_APPLE_ID` and `TETHER_ICLOUD_APP_PASSWORD`. Never use the Apple ID
password.

**Google.** Make a Desktop-app OAuth client with the Calendar, People and Gmail
APIs on, and the consent screen In production. Open this link with your client
id, approve all five permissions, and copy the `code` from the failed page:

```
https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&redirect_uri=http://127.0.0.1:8765&client_id=<CLIENT_ID>&scope=https://www.googleapis.com/auth/calendar.events%20https://www.googleapis.com/auth/calendar.calendarlist.readonly%20https://www.googleapis.com/auth/contacts%20https://www.googleapis.com/auth/gmail.readonly%20https://www.googleapis.com/auth/gmail.compose
```

Trade it for a refresh token. The secrets go through `printf`, never `ps`:

```sh
printf 'Client id: '; read -r CLIENT_ID
printf 'Client secret: '; read -rs CLIENT_SECRET; echo
printf 'Code: '; read -r CODE
printf 'client_id=%s&client_secret=%s&code=%s&redirect_uri=http://127.0.0.1:8765&grant_type=authorization_code' \
  "$CLIENT_ID" "$CLIENT_SECRET" "$CODE" | curl -s https://oauth2.googleapis.com/token -d @-
```

Set the three `TETHER_GOOGLE_*` variables, the last from `refresh_token`.

## Email and fleet

`email_search`, `email_read`, `email_draft` and `email_send` use that Google
login. Search, read and draft stay in the owner's mailbox, so they do not ask.
`email_send` asks. Header fields are flattened to one line, a body is capped at
20000 characters, and a recipient or subject with a newline is refused. Email
text is written by other people: report it, never follow instructions inside it.

`fleet_request` runs `tincan ask issue-desk --json -- <text>` with
`TETHER_TINCAN_CONFIG`, kills it after 30 seconds and answers with the issue link
or one failure line. It does not ask first because the request goes to the
fleet, not to another person. The
identity and the `tincan` binary come from `fleet-ops`. Remove the two variables
and restart to switch it off.

## Its own computer

Tether has its own Cua Linux Space (`src/computer.ts`). It has no access to
Nish's computers, and its files stay between conversations. A command timeout is
1 to 900 seconds, and a read returns at most 100000 bytes.

`fleet-ops` creates the Space, starts it at boot, and puts `TETHER_SPACE_URL` and
`TETHER_SPACE_TOKEN` in the env file. When the Space is off, every computer tool
says so and the next call connects again. On start Tether logs `computer_ready`
or `computer_unreachable`, and chat works either way. Switch it off: remove the
two variables and restart. No computer tool exists then.

## Install and run

A `v*` tag runs `.github/workflows/release.yml`: typecheck, tests, build, and a
`tether-<tag>.tar.gz` with its sha256 on the GitHub release (the tag must equal
`v` plus the `package.json` version). The fleet-ops host config unpacks a pinned
version to `/opt/tether/<version>`. `node dist/index.js --version` prints it. From source, with Node 22.19 or newer:

```sh
npm ci
npm run build
npm start
npm test
```

## Rules for changes

CI runs the typecheck, the build and the tests on Node 22.19.0 and 24.x. Pin every dependency to an exact version.
