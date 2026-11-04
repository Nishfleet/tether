# Morning brief

One text a day at 08:00 in `TETHER_TIMEZONE`: today's calendar, reminders due today, and the weather where the owner last was.

## Sub-features
- Sends at the set time, once, across a restart.
- Skips a missing or failing source and sends the rest.
- `brief_set` moves the time, `brief_off` stops it.
- Sends nothing and calls no source while STOP is on.

## How to get to it (user POV)
Wait for 08:00, or text "brief at 7:30" or "stop the brief".

## Driving it with the rig
`node --no-warnings --test --test-reporter=spec tests/brief.test.ts`
End state: every test `✔`. The rig uses a fake clock and timer, so no drive waits for real time.

## Gotchas
Weather comes through the injected fetch. The rig stubs it, so a real Open-Meteo outage does not show here.
