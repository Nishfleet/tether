# Tether

Owner: **nish3451** (`.github/CODEOWNERS`: `* @nish3451`).

Tether is a personal agent that chats over iMessage and runs on the VPS as a
system unit. Phase 1 is chat, its own memory notes and crash-proofing, nothing
else: no shell, no GitHub, Cloudflare or database tokens, no deploys, no web
access. The spec is `Nishfleet/fleet-ops#9980`. The unit, the service user, the
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
  handle.
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
- **Tools.** Those two and nothing else.
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

Any future web or HTTP tool must refuse loopback, private, link-local and
tailnet hosts. The model router's port also serves an unauthenticated
`/metrics`.

## Rules for changes

Every change is a PR to `main` with CI green. Dependencies are pinned to exact
versions in `package.json` and `package-lock.json`. No comments in app code. No
Photon keys, handles, phone numbers or other credentials in the repo, issues,
PR text or logs: names only.
