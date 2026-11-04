# STOP and RESUME

STOP halts everything: the model call in flight, pending approvals and the brief. RESUME restarts without re-asking stopped work.

## Sub-features
- STOP aborts the model call and sends nothing for it.
- RESUME does not re-run the stopped request or an exhausted send.

## How to get to it (user POV)
Text STOP. Later, text RESUME.

## Driving it with the rig
`node --no-warnings --test --test-reporter=spec --test-name-pattern="STOP aborts|re-ask an exhausted" tests/app.test.ts`
End state: 2 tests `✔`.

## Gotchas
STOP and RESUME count only as the whole message, in any case (`src/control.ts`). "please stop" is a normal text.
