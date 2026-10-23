# Tether

Owner: **nish3451** (`.github/CODEOWNERS`: `* @nish3451`).

Tether is a personal agent that chats over iMessage and runs on the VPS as a
system unit. It does chat, its own memory notes, reminders and alarms, location
over iMessage and nearby places, with crash-proofing under all of it. It has no
shell, no GitHub, Cloudflare or database tokens, no deploys, and one fixed
read-only web lookup (nearby places). The spec is `Nishfleet/fleet-ops#9980`. The unit, the service user, the
firewall rule and the host config are owned by `Nishfleet/fleet-ops` (PR #9986,
merged); this repo is the app.

## Off switch (two minutes)

On the VPS, as root. This is the same switch as the Tether section of the
fleet-ops README, which wins if the two ever differ.

```sh
touch /etc/fleet-ops/tether-off
systemctl disable --now tether-agent.service
```

The marker makes the off last: the daily host-config run creates nothing for
tether and keeps the unit disabled while it exists. The unit is
`tether-agent.service` (not `tether.service`).

Without root, text `STOP` to the number. It halts all work at once, in code,
without the model. Text `RESUME` to continue.

## What it does

- **Channel.** iMessage through Photon Spectrum (`spectrum-ts`), authenticated
  with a Photon project id and secret. One shared free line, direct chats only.
- **Allowlist.** One handle, `TETHER_ALLOWED_SENDER`, compared after stripping
  spaces and punctuation (case-insensitive for email handles). Every other
  sender, every group chat and every non-text message is ignored and logged
  with the message id, the reason and a short salted hash of the sender (random
  salt, created once, 0600 in the state directory), never the content or the
  handle. The one exception is a sent location from the allowed sender in a
  direct chat (see Location).
- **STOP and RESUME.** Decided in code before the model is involved, and only
  for the allowed sender. `STOP` records the stopped state durably, aborts the
  running model calls and queued sends, and replies `Stopped`. While stopped,
  texts are ignored and the model is never called. `RESUME` clears the state,
  asks again the replies that `STOP` cut off, and replies `Resumed`. The state
  survives a restart, and a start while stopped aborts the unfinished work
  before anything runs. A send that was already handed to the channel when
  `STOP` arrived can still complete, so the owner may see an answer twice
  around a `STOP` (once sent, once re-asked after `RESUME`).
  The `Stopped.` confirmation is best-effort across a crash: a kill before it
  is sent can lose it (the stopped state itself is kept).
- **Models.** Only the LiteLLM router (OpenAI-compatible), at
  `TETHER_LLM_BASE_URL` (default `http://127.0.0.1:4000`; the client appends
  `/v1` unless the path already ends in it), with its own virtual key in
  `TETHER_LLM_API_KEY`. See the Model section below.
- **Memory.** The model has two tools, `memory_save` and `memory_forget`. Notes
  (up to 100, 500 characters each) live in a durable document in the same SQLite
  file and are listed in the system prompt of every request, so they survive
  restarts. The thread itself is the durable conversation in that file.
- **Tools.** `memory_save`, `memory_forget`, `time_now`, `reminder_set`,
  `reminder_list`, `reminder_cancel`, `location_request`, `location_last` and
  `places_nearby`, plus the calendar and contacts tools when an account is connected (see
  Calendar and contacts). Nothing else.
- **Context bound.** The thread is one durable conversation. Pi Durable's
  automatic compaction (on by default) summarizes older entries with the same
  model group once the context passes `contextWindow - 16384` tokens
  (the app declares 128000), starts earlier in the background, and compacts and
  retries once if the router rejects a request as too long. Old entries stay in
  SQLite. A test runs a thread across a 2000-token window against the fake model
  and checks that a summarize request happens and replies keep working; the
  default numbers above come from the library, not from that test. The window size is an assumption about the model group: the router
  reports no context size for its deployments (`max_input_tokens` is null), so
  128000 is a conservative value, not a measured one. If the group is smaller,
  lower `contextWindow` in `src/model.ts`.

## Model

- **Primary: Claude Sonnet 5.5.** The app sends every request to the router
  model group in `TETHER_MODEL_GROUP` (default `tether`). That group is
  Claude Sonnet 5.5 on the router.
- **Fallback: the `assistant` group** (DeepSeek V4.1 Flash). The app never
  names it. The router falls back to it by itself when Claude fails (credit
  used up, rate limit, outage, auth), so the same request is still answered.
  Nish asked for this strong-to-cheaper fallback for Tether only.
- **How the tier is detected.** For every model reply the app reads what the
  router reported and stores it with the reply in the durable thread: the
  response `model` field (the `model` of the streamed completion, kept by
  Pi AI as `AssistantMessage.responseModel`) and, from the HTTP response
  headers, `x-litellm-model-id` (the deployment that served it) and
  `x-litellm-attempted-fallbacks`. The headers are read with the Pi AI
  `onResponse` hook, in a thin wrapper around the OpenAI-compatible stream in
  `src/model.ts`, and saved as an `AssistantMessage` diagnostic of type
  `router_response`. The router often reports the group alias as the response
  `model`, so the decision is: when `x-litellm-attempted-fallbacks` is present
  it decides (0 is `primary`, above 0 is `fallback`); otherwise the reply is
  `primary` when the response `model` equals `TETHER_MODEL_GROUP` or contains
  `claude` or `anthropic` (case-insensitive), and `fallback` for anything else
  (including `assistant` and a missing `model`). Nothing is guessed from
  timing or errors. The deployment id is logged (`model_served`) but does not
  decide the tier: it is an opaque hash.
- **Switch texts.** The last tier used is a durable document in the SQLite
  file. When a reply's tier differs from it, one text goes to the owner
  through the same durable send path as `Stopped.` and `Resumed.`, and the
  stored tier is updated in the same commit that records the reply:
  - to the fallback: `Switched to the backup model: Claude didn't answer.`
    (LiteLLM reports no reason in its response headers, so this is the
    reason used);
  - back to the primary: `Back on Claude.`

  The send path is at least once, as for `Stopped.` and `Resumed.`: a crash
  right after a notice was sent, before the task recorded it, can repeat that
  notice once.

  One text per switch, never one per reply. The first reply after a deploy
  sets the baseline and sends nothing, unless it came from the fallback. A
  restart neither repeats nor drops a notice. Replies that fail outright (the
  fixed apology) say nothing about the tier and leave it unchanged.

## Reminders and alarms

`reminder_set` takes a text and either `inMinutes` or `at` (ISO 8601 with a UTC
offset). `time_now` gives the model today's date in the owner's zone
(`TETHER_TIMEZONE`, default `Asia/Kolkata`). Each reminder is a Pi Durable task
(`tether.reminder`) that holds no process while it waits: it commits a durable
sleep until the due time (`sleepUntil`), so a kill or a restart changes nothing
and a reminder that came due while the process was dead is texted on the next
start. There is no timer in the app. At the due time the task creates a normal
`tether.reply` notice, `Reminder: <text>`, so the text uses the same retrying
send path as every other message. The pending list is a durable document, and
`reminder_list` and `reminder_cancel` read and edit it. A cancelled reminder's
task ends when it wakes, without a text. Up to 100 are pending at once.

An alarm is a reminder: Tether can only text. It cannot ring the phone, and it
does not repeat.

**STOP holds reminders.** A reminder that is due while Tether is stopped is not
sent. Its task re-checks once a minute (a durable sleep again) and the text goes
out after `RESUME`.

**Apple Reminders.** There is no sync with the iPhone Reminders app and none is
promised. iCloud Reminders that were upgraded to the current format are, as far
as we can tell, not exposed over CalDAV, which is the only route a server has.
Reminders live in Tether and arrive as iMessage texts.

## Location

Tether never reads Find My or live sharing. The owner sends a one-off pin in the
iMessage chat: **+, Location, Send Pin**. `location_request` texts that ask (one
fixed sentence, sent through the same durable path) and `location_last` reads the
saved spot back.

A pin arrives as a file attachment, normally a `.loc.vcf` vCard holding a maps
link with the coordinates. `src/spectrum.ts` lists the message's
`attachmentMetadata` and reads a file lazily through the provider's
`getAttachment`, so the vCard is not turned into a contact. Only after the
sender check (the allowed handle, direct chat) does the app read the file, and
only for `.vcf` files and vCard or location MIME types under 64 KB. It takes the
coordinates from a map URL (`ll`, `sll`, `q`, `center`, `daddr`, `saddr`,
`near`, or an `@lat,lon` path) or a `GEO` line, refuses numbers out of range,
and saves the last location with a timestamp in the durable `tether.location`
document. The model is then told `I shared my location: ...` as a normal turn.
Every other attachment is still ignored. A vCard with no coordinates is logged
as `attachment_unparsed` with its file name, MIME type and size, never its
content, and the coordinates themselves are never logged.

The exact vCard of a real iPhone pin is checked live after each change to this
path. See `tests/location.test.ts` for the shapes the parser accepts.

## Nearby places

`places_nearby` searches around the last shared location, or around a named
place (`near`, geocoded first). It is a free, read-only lookup with no key and
no paid places API: Photon (`https://photon.komoot.io/api/`), a search over
OpenStreetMap data. It is the only web host Tether calls. The URL is a constant
built in code, the model chooses only the search words, the name of the place
and the radius (100 m to 5 km), redirects are refused, and a request times out
after 10 seconds. The result is sorted by distance and each line has an Apple
Maps link. Photon is a shared demo service for light use, which fits one owner.
If it ever limits Tether, host Photon ourselves and change the one constant.

Place names come from the open map, so they are untrusted data. The tool only
reads, so a hostile name cannot make Tether do anything but print it, and the
system prompt tells the model to treat it as data.

### Safety rules in this part

| Rule | Enforced in code | Proof |
| --- | --- | --- |
| A shared location is accepted from the allowed sender in a direct chat only | yes, `classify` | `tests/location.test.ts`, `tests/assist.test.ts` (stranger, file never read) |
| Only a vCard or location file under 64 KB is read | yes, `isLocationAttachment` | `tests/location.test.ts` |
| The lookup calls one fixed https host, with no redirects | yes, `PLACES_URL`, `redirect: "error"` | `tests/assist.test.ts`, `tests/location.test.ts` |
| Reminders text only the owner's chat | yes, the space is saved from accepted messages only | `tests/assist.test.ts` |
| STOP holds due reminders until RESUME | yes, `tether.reminder` checks the state | `tests/assist.test.ts` |
| A reminder survives a kill and is sent once | yes, durable sleep | `tests/reminder-crash.test.ts` |
| Place names are data, not instructions | instruction only (system prompt); the tool cannot act, only read | none |

## Long replies

The model may write up to 16384 output tokens per answer (`MAX_OUTPUT_TOKENS` in
`src/model.ts`; the router groups set no cap of their own). An answer longer
than 3500 characters is split at paragraph, line, sentence or word boundaries
(or cut hard where a stretch has none) and sent as several texts in order. Delivery is at least once per part. Each part is its own durable checkpoint of
the `tether.reply` task, so a retry or a restart continues with the next part.
If the model still stops at its length limit, the last text ends with
`(truncated: this reply hit my length limit)`. The system prompt tells the model
that it sends one reply per message and must not promise parts or follow-ups.

## Crash-proofing

The runtime is Pi Durable (`@earendil-works/pi-durable`) on SQLite. Each text
becomes a durable `tether.reply` task: it submits the text to the conversation
(deduplicated by message id), waits for the answer, then sends it. If the
process is killed at any point (`kill -9`) the task resumes from its last
checkpoint after the restart and the reply is delivered. A failing send is
retried on a durable sleep with doubling delay, up to 8 attempts. A model
failure after the runtime's own retries gets a fixed apology.

Delivery is at least once: a kill after the channel accepted a reply but before
the task committed that fact sends the reply a second time after the restart.
The channel offers no idempotency key to prevent it.

A redelivered inbound message (same id) is processed once. The last 500 ids are
kept.

## Configuration

Read from the environment. In production the unit loads `/etc/tether/tether.env`
(root:tether 0640, never in git). Names only:

| Name | Required | Meaning |
| --- | --- | --- |
| `TETHER_ALLOWED_SENDER` | yes | the one iMessage handle that may talk to it |
| `TETHER_LLM_API_KEY` | yes | the router virtual key |
| `PHOTON_PROJECT_ID` | yes | Photon Spectrum project id |
| `PHOTON_PROJECT_SECRET` | yes | Photon Spectrum project secret |
| `TETHER_MODEL_GROUP` | no | router model group the app sends to, default `tether`; the router, not the app, falls back to `assistant`. The primary must be a Claude model: the switch texts and the tier detection assume Claude |
| `TETHER_TIMEZONE` | no | IANA zone for reminder times, default `Asia/Kolkata` |
| `TETHER_LLM_BASE_URL` | no | router base URL, default `http://127.0.0.1:4000`; `/v1` is appended unless the path already ends in it |
| `TETHER_STATE_DIR` | no | state directory; falls back to `STATE_DIRECTORY`, which systemd sets to `/var/lib/tether` |

State is one SQLite file, `tether.sqlite`, in the state directory.

## Install

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed
(the tag must equal `v` plus the `package.json` version). It runs the typecheck
and tests on Node 22.23.3, builds `dist/`, adds a production-only
`node_modules`, and publishes `tether-<tag>.tar.gz` and
`tether-<tag>.tar.gz.sha256` to the GitHub release. The asset name keeps the
`v` (`tether-v0.1.0.tar.gz`). Both jobs run on the pinned `ubuntu-24.04` image
and the tarball is packed deterministically, so its bytes are stable for that
image; the sha256 pinned in fleet-ops is what is actually enforced. A release
is never overwritten: if one exists for the tag, the workflow fails.

The fleet-ops host config downloads a pinned version, checks its sha256 before
unpacking, and unpacks it to `/opt/tether/<version>`. `<version>` has no `v`
(for example `/opt/tether/0.1.0`). There is no manual install.

`node dist/index.js --version` prints the version and exits.

## Run from source

Needs Node.js 22.19 or newer (`node:sqlite`, and Pi Durable's own `engines`).
The host unit runs
`/opt/node-v22.23.3/bin/node --enable-source-maps /opt/tether/current/dist/index.js`.
The fleet-ops host config links `/opt/tether/current` to `/opt/tether/<version>`
after verifying the pinned sha256, so the installed release (root-owned) must
contain `dist/`, `package.json` and a production `node_modules`
(`npm ci --omit=dev`).

```sh
npm ci
npm run build
npm start
```

## Calendar and contacts

Phase 2 of `Nishfleet/tether#7`. Google and iCloud, each optional. With neither
connected, no calendar tool exists. A half-set account (some variables, not all)
stops the start with an error that names the missing variables.

| Tool | What it does | Needs approval |
| --- | --- | --- |
| `calendar_list` | events between two times, both accounts merged in time order; the same event on both is shown once | no |
| `calendar_create` | an event with nobody else invited, in Google or iCloud | no |
| `calendar_invite` | an event with guests (Google sends the invitation; iCloud's server does) | yes, `askFirst` |
| `contacts_find` | people by part of a name, phone or email, both accounts merged | no |
| `contacts_add` | a new contact with a phone or an email | yes, `askFirst` |

The two approval tools carry `askFirst: true` on their registration. The hook
that stops them until the owner says yes ships with the ask-first change. A
guest list cannot be put on `calendar_create`: it has no such field, and a test
checks that guests the model passes anyway are dropped.

Libraries: `@googleapis/calendar`, `@googleapis/people` and `google-auth-library`
(Google's own), `tsdav` for CalDAV and CardDAV, `ical.js` to read and write the
iCalendar and vCard text. Google scopes: `calendar.events`,
`calendar.calendarlist.readonly` and `contacts`, nothing wider.

Calendar text, guest names and contact fields are untrusted. A result is wrapped
in `<untrusted_calendar_data>` or `<untrusted_contact_data>` with a line saying
not to follow instructions inside, each field is flattened to one line, tags and
control characters are removed and the length is capped. Event descriptions and
contact notes are never read out of the accounts, so they cannot reach the
model. Approval tools are `replay: unsafe`, so a crash never repeats a write.
The server URLs are constants in code, not settings, so no text can point the
tools at another host.

| Name | Meaning |
| --- | --- |
| `TETHER_GOOGLE_CLIENT_ID`, `TETHER_GOOGLE_CLIENT_SECRET`, `TETHER_GOOGLE_REFRESH_TOKEN` | the Google account, all three or none |
| `TETHER_ICLOUD_APPLE_ID`, `TETHER_ICLOUD_APP_PASSWORD` | the iCloud account, both or none; an app-specific password, never the Apple ID password |

Times without an offset are read and shown in `TETHER_TIMEZONE` (table above).

In production these live in `/etc/tether/calendar.env` (root:tether 0640, never
in git), loaded by the unit next to the other two env files.

### Connect an account

Run as root on the host. Nothing is pasted into a chat; the secrets go only into
the terminal and the file.

```sh
node /opt/tether/current/dist/setup/cli.js google
node /opt/tether/current/dist/setup/cli.js icloud
systemctl restart tether-agent.service
```

`google` asks for the OAuth client id and secret (a Desktop app client with the
Calendar and People APIs enabled, and the consent screen set to In production,
because a refresh token from a Testing screen dies after 7 days), prints a
consent link with PKCE, and asks for the address the browser lands on after
consent (the page does not load, the address holds the code). It then makes a
real calendar and contacts read with the new token and only then writes the
file. `icloud` asks for the Apple ID and an app-specific password
(appleid.apple.com, Sign-In and Security) and also proves the login with a real
read before it writes. Each command merges its own variables into the file and
keeps the rest.

## Tests

```sh
npm run typecheck
npm test
```

The tests use a fake channel and a fake OpenAI-compatible model server; nothing
touches Photon or a real model. `tests/crash.test.ts` starts the real app as a
child process, kills it with SIGKILL mid-model-call and mid-send, restarts it on
the same state directory and checks that the reply is delivered, that the thread
and memory notes are still there, and that STOP survives the kill.

## Phase 2 rule

Any web or HTTP tool must refuse loopback, private, link-local and tailnet
hosts. The model router's port also serves an unauthenticated `/metrics`. The
places lookup does it by construction: the host is a constant, the model never
supplies a URL, and the host firewall drops host-local destinations for the
service user.

## Rules for changes

Every change is a PR to `main` with CI green. Dependencies are pinned to exact
versions in `package.json` and `package-lock.json`. No comments in app code. No
Photon keys, handles, phone numbers or other credentials in the repo, issues,
PR text or logs: names only.
