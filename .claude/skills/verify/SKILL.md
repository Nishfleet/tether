---
name: verify
description: Drive Tether, the iMessage agent, end to end through its in-process rig (the real startTether with a fake phone and a fake model) and capture evidence. Use to prove a Tether feature works after a change, before a PR, or when a reviewer asks for run-proof.
---

# Verify Tether

Tether has no web UI. A user texts it on iMessage. The real phone path needs Photon and model keys, so verification drives the **in-process rig**: `tests/rig.ts` and `tests/helpers.ts` boot the real `startTether` (`src/app.ts`) with `FakeChannel` as the phone and `FakeModel` as an OpenAI-style HTTP model on 127.0.0.1. Everything between the inbound text and the outbound text is production code: the reply task, tools, ask-first approval, durable SQLite state.

## Launch

1. `npm ci`
2. `npm run build` must exit 0.
3. Set an evidence folder: `E=${TMPDIR:-/tmp}/tether-verify-evidence/$(date +%Y%m%dT%H%M%S); mkdir -p "$E"`

There is no server to keep alive. Each drive starts its own rig in a fresh temp dir (`mkdtemp` under the OS temp dir) and closes it.

## Doctor

Run this first, and whenever a drive looks wrong:

```sh
node --version                                   # must be >= 22.19.0 (package.json engines)
env -i PATH="$PATH" HOME="$HOME" node dist/index.js; echo "exit $?"
```

The real boot must print `Error: missing environment: TETHER_ALLOWED_SENDER, TETHER_LLM_API_KEY` and exit 1. Tether fails closed without config. Exit 0 means it started with no owner, so stop and report it.

## Drive

One feature at a time, with the spec reporter, saved as evidence:

```sh
node --no-warnings --test --test-reporter=spec --test-name-pattern="<pattern>" tests/<file>.test.ts 2>&1 | tee "$E/<feature>.txt"
```

The pattern and file for each feature are in `features/`. A drive passes when every named test shows `✔` and the summary says `fail 0`.

## Evidence

- `$E/doctor.txt`: node version, build exit, real-boot exit.
- `$E/<feature>.txt`: the spec output. Each test asserts what the owner sees (texts the fake phone captured), what ran (tool calls the fake model asked for), and the durable state (SQLite rows survive a reboot of the rig).
- Proof standard: drive through an inbound text, never by calling a tool's `execute` directly. Mocks sit only at the two production boundaries: the phone (`Channel`) and the model (HTTP).

## Cleanup

The rig removes its own temp dir in `close()`. Nothing else is started. Keep `$E`. It lives outside the repo and is the proof.

## Isolation

Each rig uses its own temp dir and an ephemeral port for the fake model, so drives can run side by side.

## Not covered here

The real Photon iMessage channel, the real model router, Google and iCloud accounts, and the Cua computer. Those need live keys and are proven on the VPS deploy, not by this skill.
