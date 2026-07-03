# BCM cmsh Trainer

A browser-based simulator of **cmsh**, the command-line shell of NVIDIA Base Command
Manager, for practicing common cluster-administration workflows without real hardware.

**Live demo: [kyle-law.github.io/bcm-simulator](https://kyle-law.github.io/bcm-simulator/)**

Everything runs client-side — no backend, no build step, no dependencies.

> This is an unofficial, community-made training tool and is not affiliated with
> or endorsed by NVIDIA Corporation. "NVIDIA", "Base Command Manager", and "cmsh"
> are referenced only to describe the real tool this project helps people learn.

## Running it

Open `index.html` directly in a browser, or serve the folder:

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

## What's inside

- **Terminal** — a cmsh session against a simulated 10-device cluster (head node
  `basecm11`, `node001`–`node008`, a switch). Supports tab completion, ↑/↓ history,
  Ctrl+L clear, and `;` command chaining.
- **Rack elevation** — a live rack view whose LEDs and category tags react to your
  commands (try `power off -n node002`).
- **Guided lessons** — eight auto-checked exercises covering navigation, device
  status & power, the set/commit/refresh workflow, categories, software images,
  node provisioning, users, and monitoring. Progress is saved in localStorage.

## Simulated cmsh coverage

| Area | Commands |
|------|----------|
| Modes | `device`, `category`, `softwareimage`, `network`, `partition`, `user` |
| Navigation | `use`, `exit` / `..`, `home`, `help`, `quit` |
| Objects | `ls` / `list`, `show`, `get`, `set`, `clear`, `add`, `clone`, `remove` |
| Change management | `commit`, `refresh`, `modified` (with `*` prompt markers) |
| Device ops | `status`, `power status/on/off/reset [-n node001..node004]`, `reboot`, `sysinfo`, `latestmetricdata` |
| Provisioning | `add physicalnode <host> [ip]`, MAC identification, `imageupdate [-w] -n <nodes>` (dry run without `-w`) |

Changes are staged until `commit`, exactly like real cmsh, and referential checks
(e.g. assigning a node to a nonexistent category) are enforced.

Provisioning models the real workflow: a newly added node powers on but cannot be
identified until its `mac` is set and committed; its first boot then runs a full
image provision (`INSTALLER_BOOTING` → `INSTALLING` → `UP`) from its category's
software image, with matching event lines.

## Instructor tips

Deep-link a pre-typed session with the `play` query parameter:

```
index.html?play=device;ls;power%20off%20-n%20node002
```

The **Reset cluster** button restores the initial cluster state; lesson progress
is kept.

## Layout

```
index.html        page shell
css/style.css     styling
js/state.js       initial cluster state
js/engine.js      cmsh interpreter (modes, staging, power sim, completion)
js/lessons.js     guided lessons and their auto-checks
js/app.js         terminal / rack / lessons UI wiring
```

`state.js`, `engine.js`, and `lessons.js` also load under Node for testing.
