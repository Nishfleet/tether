# Agent rules for Tether

Tether is a personal agent that talks to one person over iMessage (owner
nish3451, spec `Nishfleet/fleet-ops#9980`). It answers only that handle,
`TETHER_ALLOWED_SENDER`, in direct chats; asks first before it messages anyone
else (`src/approval.ts`); and no tool moves money. The unit, service user and
host config live in `Nishfleet/fleet-ops`; this repo is the app. README.md has
the feature list and the ask-first table.

## Build and test

```sh
npm ci
npm run typecheck && npm run lint && npm run build
npm test
```

Node 22.19+ (`engines` in `package.json`).

## Prove it works: `.claude/skills/verify/`

`.claude/skills/verify/SKILL.md` boots the real `startTether` in the in-process
rig (`tests/rig.ts`: `FakeChannel` as the phone, `FakeModel` as the model) and
keeps the spec-reporter output as evidence. Run it after a change to a feature
it drives and before asking for review; `features/` names the test file and
pattern per feature. A green check is not a run-proof: the approver bot approves
only when checks are green and a run-proof is present (decisions ledger
2026-11-04).

## Owner-only paths

`CODEOWNERS` reserves these to `@nish3451` alone — agent rules, the review gate,
the checks and configs, secrets and the ask-first guard: `**/AGENTS.md`,
`/CLAUDE.md`, `/.github/`, `/.oxlintrc.json`, `/tsconfig.json`,
`/tsconfig.check.json`, `/package.json`, `/src/config.ts`, `/src/approval.ts`,
`/src/calendar/config.ts`.
