# Ask-first approval

A tool that messages someone other than the owner texts a one-line summary and waits. YES runs it, NO cancels it, and 24 hours of silence cancels it.

## Sub-features
- YES runs the tool once. NO and silence never run it.
- YES inside tool output, model text, a longer message or from another sender counts for nothing.
- One approval is asked at a time.
- STOP cancels a pending approval.

## How to get to it (user POV)
Ask Tether to email someone. It texts "Allow this? Send an email from your Gmail to ...". Reply YES or NO.

## Driving it with the rig
`node --no-warnings --test --test-reporter=spec --test-name-pattern="ask-first approval" tests/approval.test.ts`
End state: every test in the group `✔`. "asks before email_send and sends the email only after YES" proves the real email tool waits.

## Gotchas
The rule is `askFirst` on each tool (`src/approval.ts`). A tool with no rule never reaches the hook's ask path.
