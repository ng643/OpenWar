# Frontline

A browser territory-conquest game in the spirit of OpenFront, but instead of tapping to invade you
raise and command **divisions**: select them, march them across the map, split and merge them, and
let them fight and seize land as they go. Prototype.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173  (add ?seed=12345 for a reproducible map)
npm run build      # static build in dist/ (relative paths; single player works on any static host)
npm start          # build + game server: http://localhost:8080 (single player AND multiplayer)
npm test           # headless simulation and server integration tests
npm run sim        # AI-only balance report: npm run sim 12345 777
```

## Game setup

Choose **Single player** to open setup before starting:

- **Map size:** Small (100×64), Standard (150×96), or Large (200×128).
- **Seed:** leave blank for a random map, or enter a reproducible integer seed (including 0).
- **Starting resources** and **income rate:** ×0.5, ×1, or ×2.
- **Victory target:** 50–100% of the land, adjusted in 1% steps with the slider (default 60%).
- **AI difficulty:** Easy, Medium, or Hard. These select AI decision policies, not resource or combat bonuses;
  Medium retains the original controller's policy.
- **Fog of war:** start with fog enabled or disabled.
- **Roster:** choose the number of active seats and reserved bots, or set each seat to Open, Bot, or Off.
  The limit is the number of cities on the previewed map: usually 14 / 24 / 38 for Small / Standard / Large.
  City placement is independent of the roster; unused cities stay neutral. Open seats can be claimed by
  humans, and any unclaimed open seat is played by an AI when the match starts.
- **Teams:** choose free-for-all or a team count, use **Auto-balance**, and adjust individual seat assignments.
  Bots participate in the same teams. Allies share vision, logistics and fortress cover, cannot damage or
  capture one another, yield friendly traffic, and win together. Units, reserves, spending and construction
  remain controlled by their individual owners.
- **Your seat:** choose an open seat or **Spectator** for an all-AI match. Reserved bot seats cannot be claimed.

Spectators see the whole map and all empires' statistics, can move the camera, and cannot issue
orders or place buildings. Local spectators retain pause and speed controls. **New game / rematch**
returns to setup with the previous choices retained.

## Multiplayer

Rooms support up to 64 connected clients, including spectators, and one human per open active seat.
The player limit is the map's actual city count; reserved bot seats cannot be claimed by humans.
AI controls reserved bots and active seats without a player. One Node process serves the client and WebSocket game server.

```bash
npm start                      # http://localhost:8080
# or, for client development with hot reload:
npm run server                 # game server on :8080 (needs a prior npm run build only for static files)
npm run dev                    # Vite on :5173, connects to ws://<host>:8080/ws
```

Open the page, enter a name and a room code (blank = new room), then share the invite link
(`?room=CODE`). Use **Join / create room** to play or **Watch as a spectator** to watch.
The host chooses the rules, active roster, reserved bots and teams; guests can change only their own seat
or switch to spectator. The host presses **Start game** and can host an all-AI match as a spectator.
If the lobby host leaves, setup controls transfer to the new host; guests remain read-only.
Spectators can also join a running game. Multiplayer runs at fixed 1x speed (no pause).
A page reload or dropped connection rejoins your role and seat; if a player stays away for 20 s the
AI takes over until they return. Rematches keep the room's setup and roles. Eliminated players keep
watching with fog off. `PORT` sets the server port; `?server=ws://host:port/ws` points the client at
a different server.

For separate frontend hosting, build with `VITE_SERVER_URL=wss://your-backend.example/ws`.
On the backend, set `ALLOWED_ORIGINS` to the frontend's full origin, for example
`https://ng643.github.io`. Multiple trusted origins may be comma-separated; unrelated origins remain
blocked, while same-host pages keep working without an allowlist. Do not put credentials in the
public frontend URL or repository variable.

The GitHub Pages workflow in `.github/workflows/pages.yml` builds `dist/` and deploys it on pushes
to `main` or manual runs. Enable Pages with **GitHub Actions** as its source and set the Actions
repository variable **`MULTIPLAYER_SERVER_URL`** to the verified public `wss://` endpoint.
Pages hosts only the browser game; a running Node backend is still required for multiplayer.

**How it works:** the server is authoritative. It runs the same deterministic sim as single player, accepts
only validated *commands* (`src/sim/commands.js`), and sends each player a 10 Hz *snapshot* containing
only what that player can see when fog is enabled: allied divisions share visibility, and enemies outside
the team's vision are never transmitted. Other factions' resource balances remain private under fog.
Spectators and games with fog disabled show the whole map and all empires' statistics; other factions'
movement routes remain private. A visible ally's exact return anchor is shared so friendly placement previews agree.
Territory is sent as deltas; terrain is regenerated client-side from the seed and configured dimensions.
Single player uses the very same command path locally.

## Gameplay

- Two resources. **Manpower** fills divisions and reinforces connected units wherever they are; income
  is soft-capped by reserves plus fielded strength. **Gold** pays for equipment, buildings and roads. Land and
  cities provide a modest baseline, but completed **Farms** and **Factories** drive economic growth.
  Every division costs both resources.
- **Buildings** (`J` / `K` / `L`, click to place, right-click or Esc to stop): **Farm** (25 gold, any plain
  land you own, drag to paint a field, +1 manpower/s before the soft cap), **Factory** (+4 gold/s, and
  required within 5 tiles of a city to raise Armor / Artillery there) and **Fortress** (defenders within
  3 tiles take 40% less damage). Factories
  and Fortresses must be inside the 5-tile circle around one of your cities (select a city to see it) and get
  dearer with every one you own. Income starts only after construction finishes. Captured Farms and
  Factories transfer intact to the new owner, including unfinished construction with its original
  completion time. Captured Fortresses are destroyed and immediately stop protecting nearby units.
  Every capital starts with a free Factory.
- **Drawable formations:** select divisions, then hold right-click and drag to draw a straight destination
  line. Hold **Ctrl before pressing right-click** to trace a freehand curve instead. The dashed preview
  shows equally spaced positions along the line or curve with distinct nearby free land slots;
  release to send the order. Press **Esc** to cancel, including while Ctrl is held. A quick right-click
  still moves divisions in a loose grid; city rally points and minimap orders are unchanged.
  Unreachable slots leave previous orders intact. **Shift + right-click** appends a route checkpoint;
  **Shift + left-click** still adds or removes divisions from the selection.
  Ordinary orders **stop to fight, retain their route, and resume after combat**.
- **Routes and columns:** **Shift + right-click** adds a checkpoint, up to 128 points. Divisions visit
  checkpoints in order, even when they must route around traffic. **C** (or **Column**) toggles
  single-file travel for right-click orders: members share the bends, keep at least 1.2 tiles apart,
  travel at their slowest member's pace, and finish on separate staggered slots. A plain right-click
  with column mode off replaces the route; right-drag still draws a formation in either mode.
- **Solid divisions:** bodies cannot overlap or walk through one another. Moving friendly divisions
  can nudge holders aside at the holders' walking pace. Displaced holders return to their exact holding
  position once traffic clears; orders for other divisions cannot claim those saved positions.
  Terrain, map edges and other bodies constrain every displacement. Attacking divisions can push
  defenders back at `max(0, attacker top speed - defender top speed + 0.25)` tiles/s; roads do not change
  this normal-top-speed calculation. A blocked division keeps its order rather than teleporting.
  The attacker follows into the vacated ground at the push pace, avoiding repeated disengage-and-lunge cycles.
- **Routing:** a division wounded in combat below 40% strength flees in a seeded random direction,
  6–12 tiles away, rather than returning to a city. It may disengage from its initial opponents but
  still takes damage and cannot pass through bodies. If intercepted by a new enemy, or engaged again
  after breaking contact, it is cornered: no second flight, and it fights while contact lasts.
  An uninterrupted router resumes its retained intention at 70% strength. New move, formation or route
  orders change that intention; Halt clears it without cancelling the immediate flight.
- **Divisions:** an atomic unit is one normal division (Infantry 100, Armor 90, Artillery 60) and can
  never split further. Merging stacks nearby same-type detachments into one body of up to 10 atomics
  (infantry 1000, armor 900, artillery 600 men); splitting peels one atomic back off, so a full stack
  splits back down to exactly ten atomics. Neither creates nor loses men, and engaged, routing or
  cornered divisions can do neither.
- Non-routing divisions capture only their own tile and the four tiles beside it, at the rate of one
  atomic unit at most however tall the stack stands. Taking enemy land costs men.
- **Infantry** is balanced. **Armor** is fast and hard-hitting but pricey. **Artillery** shells enemies up
  to 5 tiles away but cannot capture land and is weak in melee.
- **Logistics:** divisions need a continuous owned-land route to an owned city. A unit immediately
  outside connected territory can draw supplies across one frontier step; deeper incursions are isolated.
  With effective distance `D`, damage output is `0.5 + 0.5 / (1 + D / 20)` and reinforcement is
  `3 / (1 + D / 20)` men/s. Reinforcement requires no melee engagement and is paid man-for-man from
  manpower reserves. Isolation means half damage output and no reinforcement, **not passive troop loss**.
- **Logistics view** (`O` or the Logistics button): toggle each division's actual supply chain to its
  supplying city and its current damage output, coloured red to green from 50% to 100%.
  Players see their own divisions; spectators see every visible division from every faction.
  Cut-off divisions show a red **✕ 50%** marker without a fabricated city line. The overlay starts off.
- **Roads** (`B` or the Road button): click a start on your own land, **Shift + click** bends, then click
  the endpoint or press **Enter** to build. Right-click, Esc or losing focus cancels the sketch.
  Roads cost 2 gold per new tile, increase movement speed by 1.5× and reduce logistics travel cost to 25%.
  Existing road tiles are free to reuse; roads survive capture and can coexist with buildings.
  Invalid or unaffordable sketches place nothing and charge nothing.
  AI road projects follow logistics need: distant connected troops first, then long links between cities.
  They spend a policy-selected share of gold income (30% on Medium), preserving recruitment and construction reserves.
- **Fog of war:** when enabled, you only see enemy divisions near your divisions and cities. Toggle with
  `V` in single player; multiplayer uses the host's setup choice. Spectators always see the whole map.
- Hold the configured share of the land to win (60% by default). Controls are in the in-game help panel (`/`).
- **Cede land** (`G` or Cede land): choose a living teammate, drag a rectangle, then press **Enter** or
  **Cede N tiles**. The preview counts only land you own; a click selects one tile. One command transfers
  the whole swath, ignoring neutral and other players' tiles. Right-click, Escape or losing focus cancels.
  Cession is free and peaceful: cities, buildings (including fortresses and unfinished deadlines) and roads
  change hands intact, while your divisions stay yours. Giving away **all** remaining territory eliminates
  your faction and removes its divisions. Bots make small, conservative teammate-city border transfers,
  protecting their own cities, buildings and nearby troops.

## AI training

The difficulty profiles are **evolved decision parameters**, not neural networks or resource cheats.
The trainer runs the real simulation, mutates and crosses every bounded policy value in
`src/sim/ai-policy.js`, and keeps measured candidates. Medium stays at the original policy; Hard is
the strongest validated evolved candidate. Easy comes from a separate bounded search that selects
genuinely weaker measured policies. Two of the knobs govern the muster pass: `mergeWound` consolidates
wounded idle detachments into same-type stacks of up to ten atomics, and `splitHunger` peels an atomic
off stacked idle bodies while the frontier is hungry. Both call the same `mergeDivs`/`splitDivs` a
player's commands call, so the AI never conjures men, capacity or capture credit, and it never touches
engaged, routing, cornered or otherwise busy divisions.

The shipped run used 12 candidates, six generations, and a ten-minute simulation limit per match.
Training, Hard selection, Easy selection, and final assessment use disjoint seed sets. Every comparison
plays both faction assignments to reduce map/seat bias. The latest run (8 October 2026 game build,
seeds 5101…7207, 32 games per pair) assessed **Hard–Medium 22–10**, **Hard–Easy 32–0**, and
**Medium–Easy 32–0**. The original training assessment used 16 fresh seeds (32 games per pair), before
the roster-independent city layout:

| Comparison | First wins | Second wins | No winner by the limit |
|---|---:|---:|---:|
| Hard vs Medium | 27 | 4 | 1 |
| Hard vs Easy | 31 | 1 | 0 |
| Medium vs Easy | 21 | 11 | 0 |

The unchanged deployed profiles were then independently reassessed on the new city layout using 16 further
fresh seeds and both seats (32 games per pair): **Hard–Medium 23–9**, **Hard–Easy 30–1** with one no-winner,
and **Medium–Easy 28–3** with one no-winner. These are aggregate FFA measurements, not guarantees on every
map or benchmarks of team games. Training, Easy search, original scores and the new `postRosterAssessment`
are recorded in `src/sim/ai-models.json`; `src/sim/ai-models-pass1.json` preserves the input pass's provenance.

To reproduce the shipped training command:

```bash
npm run train -- --pop 12 --gens 6 --minutes 10 --seeds 101,202,303 --eval-seeds 9109,9203,9407,9601 --easy-seeds 8302,8404,8506,8608 --assess-seeds 5101,5203,5309,5407,5501,5603,5701,5807,6501,6603,6709,6803,6907,7001,7103,7207 --weaken-gens 3 --weaken-pop 10 --master-seed 20250923 --init src/sim/ai-models-pass1.json --out src/sim/ai-models.json
```

`npm run train -- --help` lists the bounds and options. Training is a headless offline task; playing
uses only the resulting frozen profiles, in both local and authoritative multiplayer simulations.

## Layout

```
src/
  config.js            default dimensions, unit types, ranges, colours, tunables
  setup.js             map presets, setup defaults and shared settings validation
  util.js              seeded RNG, noise, clamp
  sim/                 pure simulation, no DOM, deterministic per seed
    world.js           world state, creation, setOwner, event bus (subscribe/emit)
    mapgen.js          terrain generation
    city-layout.js     seeded, roster-independent city capacity and placement
    teams.js           shared alliance relation
    cession.js         validated, peaceful rectangle handover to a teammate
    pathfinding.js     road-aware A* + nearestLand
    divisions.js       spawn / raise / orders / split / merge
    formations.js      shared polyline-slot geometry for previews and authoritative orders
    collision.js       solid bodies, swept movement, free placement and slot allocation
    combat.js          melee + artillery fire
    movement.js        movement + land capture
    routing.js         combat flight, queued route checkpoints and column travel
    supply.js          versioned city-connectivity distances and paths, damage and reinforcement falloff
    roads.js           owned-land road sketches, previews and atomic paid construction
    travel.js          shared terrain/road movement costs
    buildings.js       placement rules, costs, factory lookup, per-player tallies
    proximity.js       shared friendly-city and live-fortress range checks
    economy.js         manpower + gold income, reinforcement
    ai.js              AI controller
    ai-policy.js       bounded, frozen decision policies and deployed difficulty lookup
    ai-models.json     trained profiles, selection measurements and provenance
    vision.js          fog-of-war visibility flags
    game.js            tick(), win/lose detection
  client/              browser-only
    camera.js          camera maths
    ui-state.js        selection, groups, pings, fog flag
    commands.js        player actions (shared by keys, mouse, buttons)
    input.js           mouse / keyboard / minimap wiring
    renderer.js        canvas drawing: terrain, territory, fog, units, minimap
    hud.js             DOM HUD, toasts, end screen; turns sim events into feedback
    net-world.js       client mirror of the server world (built from init + snapshots)
    session.js         local session (runs the sim) and net session (WebSocket)
    menu.js            main menu + lobby
    settings-form.js   shared local-setup and multiplayer-lobby controls
  net/protocol.js      wire protocol docs + constants shared by client and server
  main.js              bootstrap, session management, render loop
server/
  index.js             HTTP static server + WebSocket endpoint, room registry, main loop
  room.js              lobby, authoritative game, reconnect handling, rate limiting
  snapshot.js          per-player fogged snapshot builder
test/sim.test.js       vitest suite for the sim
test/buildings.test.js buildings, farms, fortress, factory gating, AI economy
test/net.test.js       server integration tests (lobby, fog filtering, command validation, rejoin)
scripts/simulate.js    headless balance harness
scripts/train-ai.js    seeded evolutionary policy training and independent assessment
```

## Design notes

- **Sim/client split.** Everything under `src/sim` takes a `world` object and never touches the DOM, so it
  runs in Node for tests and balance sims. The client reads the world and sends commands; the sim
  reports back through `emit(world, type, data)` events (`cityCaptured`, `divisionDestroyed`,
  `playerEliminated`, `raiseFailed`, `gameOver`).
- **Determinism.** All sim randomness goes through `world.rand`, seeded from the map seed.
- **Fixed timestep.** The sim advances in 50 ms steps; the renderer interpolates between steps.
- **Adding a unit type** is one entry in `TYPES` (`config.js`) plus a hotkey/button; combat, movement,
  capture and the AI read the multipliers from there.
- **State-driven AI.** Small or scattered armies capture land; larger, established or threatened
  groups form battle lines with artillery behind them. Troop strength, territory, frontiers, nearby
  enemies and surviving rivals drive organization, not elapsed game time. Marching and combat orders
  stay intact. The AI is not fogged and uses the same economy, supply and collision rules as players.
  It reserves part of gold income for construction, scales investment with holdings and income, and
  keeps Farms outside every city's building radius, including neutral and enemy cities, so future
  Factory/Fortress sites remain clear. An unbuildable category does not block other investments.

## Ideas not done yet

Naval/air, diplomacy, building upgrades / selling, supply depots, accounts/matchmaking.
