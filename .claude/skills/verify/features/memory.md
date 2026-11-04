# Memory notes

`memory_save` and `memory_forget` keep up to 100 short notes, ids `n1`, `n2`, and so on. The model sees them on every turn.

## Sub-features
- Save a note from a text.
- Two saves in one message keep both notes.
- A forgotten note's id is never reused.

## How to get to it (user POV)
Text "remember I prefer oat milk". Later, text "what do I prefer?".

## Driving it with the rig
`node --no-warnings --test --test-reporter=spec --test-name-pattern="memory note|two saves|forgotten" tests/app.test.ts`
End state: 3 tests `✔`. The later model request contains "prefers oat milk".

## Gotchas
The fake model replies only with what the test queues, so a drive with no queued reply waits until the test times out.
