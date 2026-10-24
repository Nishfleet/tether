# Tether

Owner: **nish3451** (`.github/CODEOWNERS`). Spec: `Nishfleet/fleet-ops#9980`.

Tether is a personal agent that talks to one person over iMessage. It runs on
the VPS as `tether-agent.service`. The unit, the service user, the firewall rule
and the host config belong to `Nishfleet/fleet-ops`; this repo is the app.

It works the way the big-company agents do: it answers only its owner, it uses
its tools and connected accounts freely, and it asks first only before it
messages someone else or spends money.

## What it does

- **Chat.** iMessage through Photon Spectrum (`spectrum-ts`), direct chats only.
  It answers one handle, `TETHER_ALLOWED_SENDER`. Every other sender, group chat
  and non-text message is ignored. The log keeps the message id and the reason,
  nothing else.
- **Memory.** `memory_save` and `memory_forget` keep up to 100 short notes with
  ids `n1`, `n2`, and so on. The notes are shown to the model on every turn.
- **Reminders and alarms.** `reminder_set`, `reminder_list`, `reminder_cancel`.
  A reminder is a Pi Durable task that sleeps until it is due, so a restart or a
  kill changes nothing. Tether can only text, it cannot ring the phone.
- **Location.** Tether reads the owner's Find My location through Photon's Find
  My API. `location_request` sends a request card the owner taps Share on,
  `location_last` reads the current location with its age, and `places_nearby`
  searches around it with Photon (OpenStreetMap data, no key). Nothing from Find
  My is stored and coordinates are never logged.
- **Calendar and contacts.** Google and iCloud, each optional.
- **Its own computer.** A Cua Linux Space on the server, see below.
- **Long answers.** A long reply is split into several texts in order. The model
  can also send parts with `text_owner`.
- **Time.** `time_now` gives the date in `TETHER_TIMEZONE`.

## Tools

| Tool | What it does | Asks first |
| --- | --- | --- |
| `memory_save`, `memory_forget` | notes | no |
| `reminder_set`, `reminder_list`, `reminder_cancel` | reminders | no |
| `location_request`, `location_last`, `places_nearby` | location and nearby places | no |
| `text_owner` | an extra text to the owner | no |
| `time_now` | today's date and time | no |
| `calendar_list`, `calendar_create` | read and add your own events | no |
| `calendar_invite` | an event with guests, who get an invitation | **yes** |
| `contacts_find`, `contacts_add` | look up and save contacts | no |
| `computer_run`, `computer_write`, `computer_read` | its own computer | no |

**Ask first.** A tool that messages someone other than the owner carries
`askFirst` (`src/approval.ts`). Before it runs, Tether texts the owner what it is
about to do and waits. `YES` runs it, `NO` cancels it, and no answer in 24 hours
cancels it. One question is asked at a time, and the wait survives a restart.
Today `calendar_invite` is the only such tool. A new tool that messages other
people must set `askFirst`. No tool moves money, so none exists for it.

## Model

Tether talks to an OpenAI-compatible router (`TETHER_LLM_BASE_URL`, default
`http://127.0.0.1:4000`, `/v1` is appended). It sends every request to one model
group, `TETHER_MODEL_GROUP` (default `tether`). The router owns fallbacks.
Tether does not look at which model answered.

## Off switch

On the VPS, as root. The fleet-ops README has the same switch and wins if the
two differ.

```sh
touch /etc/fleet-ops/tether-off
systemctl disable --now tether-agent.service
```

Without root, text `STOP`. It sets a durable stopped flag, cancels pending
questions and aborts the running work. Nothing runs and nothing is sent until
you text `RESUME`. What was running or due while stopped is dropped, not asked
again, and a reminder that comes due while stopped is logged as
`reminder_dropped`.

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
| `TETHER_STATE_DIR` | no | state directory, falls back to `STATE_DIRECTORY` (`/var/lib/tether`) |
| `TETHER_SPACE_URL`, `TETHER_SPACE_TOKEN` | no | its own computer; both or no computer tool |
| `TETHER_GOOGLE_CLIENT_ID`, `TETHER_GOOGLE_CLIENT_SECRET`, `TETHER_GOOGLE_REFRESH_TOKEN` | no | Google account, all three or none |
| `TETHER_ICLOUD_APPLE_ID`, `TETHER_ICLOUD_APP_PASSWORD` | no | iCloud account, both or none |

State is one SQLite file, `tether.sqlite`, in the state directory. A half-set
account stops the start with an error that names the missing variables.

## Connect an account

Put the variables in `/etc/tether/tether.env`, then
`systemctl restart tether-agent.service`. To disconnect, remove them and restart.

**iCloud.** Make an app-specific password at appleid.apple.com (Sign-In and
Security). Set `TETHER_ICLOUD_APPLE_ID` and `TETHER_ICLOUD_APP_PASSWORD`. Never
use the Apple ID password.

**Google.** Needs an OAuth client of type Desktop app, with the Calendar and
People APIs on and the consent screen set to In production (a Testing screen's
refresh token dies after 7 days).

1. Open this link, signed in as the account, with your client id, and approve all
   three permissions. The next page fails to load. Copy the `code` from its
   address.

   ```
   https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&redirect_uri=http://127.0.0.1:8765&client_id=<CLIENT_ID>&scope=https://www.googleapis.com/auth/calendar.events%20https://www.googleapis.com/auth/calendar.calendarlist.readonly%20https://www.googleapis.com/auth/contacts
   ```

2. Trade the code for a refresh token. The secrets go through the shell's
   `printf`, so they never show in `ps`. The answer prints to the terminal.

   ```sh
   read -rs CLIENT_SECRET; read -r CLIENT_ID; read -r CODE
   printf 'client_id=%s&client_secret=%s&code=%s&redirect_uri=http://127.0.0.1:8765&grant_type=authorization_code' \
     "$CLIENT_ID" "$CLIENT_SECRET" "$CODE" | curl -s https://oauth2.googleapis.com/token -d @-
   ```

3. Set `TETHER_GOOGLE_CLIENT_ID`, `TETHER_GOOGLE_CLIENT_SECRET` and
   `TETHER_GOOGLE_REFRESH_TOKEN` (the `refresh_token` field).

Times without an offset are read and shown in `TETHER_TIMEZONE`. Event
descriptions and contact notes are never read from the accounts. The server URLs
are constants in code.

## Its own computer

Tether has its own Cua Linux Space (`src/computer.ts`, the `@trycua/cua` SDK in
this process). It has no access to Nish's computers. Its files stay between
conversations. A command timeout is 1 to 900 seconds, and a read returns at most
100000 bytes.

`fleet-ops` creates the Space, starts it at boot, and puts `TETHER_SPACE_URL` and
`TETHER_SPACE_TOKEN` (Cua's per-Space key) in the env file. When the Space is off,
every computer tool says so and the next call connects again. On start Tether
logs `computer_ready` or `computer_unreachable`, and chat works either way.

Switch it off: remove the two variables and restart. No computer tool exists
then.

## Install and run

A `v*` tag runs `.github/workflows/release.yml`: typecheck, tests, build, and a
`tether-<tag>.tar.gz` with its sha256 on the GitHub release (the tag must equal
`v` plus the `package.json` version). The fleet-ops host config unpacks a pinned
version to `/opt/tether/<version>`. `node dist/index.js --version` prints the
version.

From source, with Node 22.19 or newer:

```sh
npm ci
npm run build
npm start
npm test
```

## Rules for changes

CI runs the typecheck, the build and the tests on Node 22.19.0 and 24.x. Pin
every dependency to an exact version.
