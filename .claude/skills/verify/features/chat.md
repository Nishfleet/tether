# Chat replies

Tether answers one handle, `TETHER_ALLOWED_SENDER`, in direct chats only.

## Sub-features
- Replies to the allowed sender in the same space.
- Ignores other senders and group chats, with no model call.
- Splits an over-long answer into ordered texts, and keeps the rest when a send fails.
- Sends a fixed apology when the model keeps failing.

## How to get to it (user POV)
Text Tether from the owner's phone.

## Driving it with the rig
`node --no-warnings --test --test-reporter=spec --test-name-pattern="allowed sender|ignores other senders|over-long answer|fixed apology" tests/app.test.ts`
End state: 4 tests `✔`.

## Gotchas
A redelivered message id is processed once. Reuse a new id per inbound text in a new drive.
