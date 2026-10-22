# Tether

Tether is a personal iMessage assistant that runs on the VPS as a system unit
(`Nishfleet/fleet-ops#9986`). It texts with one person, remembers what that
person asks it to remember, and survives crashes mid-reply.

- Chat: the single handle named by `TETHER_ALLOWED_SENDER` in
  `/etc/tether/tether.env`. Messages from anyone else are ignored.
- Control: `STOP` halts all work at once. `RESUME` continues. Neither reaches
  the model.
- Memory: the model can store and recall short notes across restarts.
- Models: whatever the LiteLLM router at `TETHER_LLM_BASE_URL` serves as the
  `assistant` model group.

Off switch (two minutes):

```sh
sudo systemctl disable --now tether.service
```

Status:

```sh
systemctl status tether.service
sudo journalctl -u tether.service -n 50
```

State directory: `/var/lib/tether` (SQLite, one file). Application install
path: `/opt/tether` (root-owned), entry point `dist/index.js`
(`ConditionPathExists=/var/lib/tether/app/dist/index.js` in the unit from
#9986 wants the app at `/var/lib/tether/app`; the packet says `/opt/tether`;
host wiring reconciles the two — see RESULT.md for the note).
