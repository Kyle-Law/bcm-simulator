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
- **Troubleshooting labs** — five scenarios that each load their own *broken*
  cluster and are graded on cluster state, not on the commands you type. You get
  a briefing, a live goal checklist that ticks off as you fix things, and
  progressive hints. Labs: an offline node, a node that won't provision (unknown
  MAC), an abandoned uncommitted change, a category pointing at a missing image,
  and a GPU node running the wrong image.

Each lesson and lab has a **Start in clean cluster** button, so you can isolate
your practice to one task and retry it from a known-good starting point. The
active scenario's cluster state is persisted, so reloading the page resumes
exactly where you left off instead of quietly handing back a healthy cluster.

- **Random drill** — a "Give me a random fault" button loads one of the
  troubleshooting labs without telling you which one. You diagnose and fix it
  blind, seeing only a live "goals met" count; the lab's name and difficulty
  are revealed once you solve it (or on demand).

## Simulated cmsh coverage

| Area | Commands |
|------|----------|
| Modes | `device`, `category`, `softwareimage`, `network`, `partition`, `user` |
| Navigation | `use`, `exit` / `..`, `home`, `help`, `quit` |
| Objects | `ls` / `list`, `show`, `get`, `set`, `clear`, `add`, `clone`, `remove` |
| Change management | `commit`, `refresh`, `modified` (with `*` prompt markers) |
| Events | `events [n]` — replay the last n cluster events |
| Device ops | `status`, `power status/on/off/reset [-n node001..node004]`, `reboot`, `sysinfo`, `latestmetricdata` |
| Provisioning | `add physicalnode <host> [ip]`, MAC identification, `imageupdate [-w] -n <nodes>` (dry run without `-w`) |

Changes are staged until `commit`, exactly like real cmsh, and referential checks
(e.g. assigning a node to a nonexistent category) are enforced.

Provisioning models the real workflow: a newly added node powers on but cannot be
identified until its `mac` is set and committed; its first boot then runs a full
image provision (`INSTALLER_BOOTING` → `INSTALLING` → `UP`) from its category's
software image, with matching event lines.

## Instructor tips

Deep-link straight into one isolated scenario with the `scenario` query
parameter (a lesson or lab id), jump into a blind drill with `drill=1`, or
pre-type a command sequence with `play`:

```
index.html?scenario=fix-provisioning
index.html?drill=1
index.html?play=device;ls;power%20off%20-n%20node002
```

The **Reset cluster** button restores the current scenario's starting state (or
the base cluster if none is active). **Reset all progress** clears lesson and lab
completion. Both leave the other alone.

## Layout

```
index.html        page shell
css/style.css     styling
js/state.js       initial cluster state
js/engine.js      cmsh interpreter (modes, staging, power sim, events, completion)
js/lessons.js     guided lessons and their auto-checks
js/labs.js        troubleshooting labs (fixtures + state-based goals)
js/app.js         terminal / rack / lessons / labs UI wiring
```

`state.js`, `engine.js`, `lessons.js`, and `labs.js` also load under Node for testing.
