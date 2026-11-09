# Blackout

A first-person horror game in a city with no power. The AIs cut the grid and kept what they needed. Six nodes still glow. Find them, hold the switch until each one goes dark, and stay away from the four hunters patrolling the streets.

Built with TypeScript, Three.js, and Vite. The city, the nodes, the hunters, every texture, and every sound are generated in code. No models, image files, audio files, backend, or API keys.

## How to play

You start in the middle of an eight-by-eight grid of blocks. Lit buildings and the light columns above them mark the nodes. Walk up to the terminal in front of a node and hold E for three seconds. Let go early and the progress drains away.

Every shutdown does two things. The hunters get faster, and all of them go to look at the spot where you threw the switch. Shut down all six and the power comes back across the city. If one of them reaches you, the round ends.

| Control | Action |
| --- | --- |
| W A S D, or the up and down arrows | Move |
| Mouse | Look (the page locks the pointer while you play) |
| Left and right arrows | Turn, if pointer lock is unavailable |
| Shift | Run. Stamina drains, then you have to wait for it to come back |
| E, or hold the mouse button | Shut down the node in front of you |
| F | Flashlight on or off |
| Escape | Pause |
| Space, Enter, or a click | Skip the ending once you have seen it |

## The hunters

Four of them, named after the models that built this game. Each starts in a different corner.

| Hunter | Nod to | Look | Habit |
| --- | --- | --- | --- |
| Opus | Claude | Wide, rounded, clay-orange light, nine cables | Slow, and it keeps chasing for seven seconds after it loses sight of you |
| Fable | Claude | Slender, rounded, three blinking dots for an eye | Fastest. When it loses you it heads for where you were going, not where you were |
| Sol | Codex | Angular, gold light, a halo | Sees half again as far as the others. Its own light gives it away from far off |
| Astra | Codex | Thin, angular, starlight, a ring of orbiting points | Hears running from 45 meters and walking from 17. Short-sighted |

They share one set of rules. With your flashlight on, a hunter sees you from about 36 meters, with it off about 14, as long as nothing stands between you. Running is heard from 24 meters and walking from 9, scaled by each hunter's hearing. A hunter that loses you checks the last place it saw you, then goes back to patrolling. Half of its patrol targets are near you.

Abandoned cars block your way and theirs, but they see over them.

The grid also knows roughly where you are. Every 28 seconds, sooner as nodes go down, it sends the nearest idle hunter to your block.

The edge of the screen turns red as one gets close, and the picture starts to tear. A heartbeat and a low growl rise with it. Headphones help.

Your best time stays in your browser. Sound can be turned off from the start screen. The game needs a keyboard and a mouse. Touch controls are not in yet.

## Run locally

Use Node.js 24 and npm. Run these from the project directory:

```sh
npm ci
npm run dev
```

Open the URL Vite prints. The app lives under the `/blackout-ai/` path locally and in production. A browser with WebGL is required.

```sh
npm run check  # TypeScript type check
npm test       # Gameplay checks using Node's built-in test runner
npm run build  # Production bundle in dist/
npm run preview
```

## Project files

| File | Responsibility |
| --- | --- |
| [src/city.ts](src/city.ts) | The grid, buildings, node sites, and spawn points for a seed |
| [src/game.ts](src/game.ts) | Player movement and stamina, collision, the switches, the four hunter profiles, their patrol, chase, and search, and the sweeps |
| [src/scene.ts](src/scene.ts) | Camera, sky, moon, flashlight, dust, bloom and film grain, and the ending's camera and sky |
| [src/world.ts](src/world.ts) | The city's geometry and canvas textures: buildings, storefronts, streets, cars, lamps, nodes, and the power wave that relights them in the ending |
| [src/hunters.ts](src/hunters.ts) | The four hunter models and their animation |
| [src/audio.ts](src/audio.ts) | Web Audio synthesis for the ambience, hum, heartbeat, footsteps, and stings |
| [src/main.ts](src/main.ts) | Input, pointer lock, HUD, overlay screens, saved preferences, and the frame loop |
| [src/style.css](src/style.css) | HUD, vignette, and overlay styling |
| [index.html](index.html) | Page structure, HUD markup, and the overlay card |
| [src/game.test.ts](src/game.test.ts) | Collision, switch holds, winning, line of sight, getting caught, and sweeps |
| [vite.config.ts](vite.config.ts) | Build path and chunking |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | GitHub Pages deployment |

The simulation in `game.ts` has no dependency on Three.js or the DOM. The tests run it directly with Node's test runner.

## Deployment

Every push to `main` installs dependencies, type-checks, runs the tests, builds the site, and deploys `dist/` to GitHub Pages. The Vite base path is set to `/blackout-ai/`. Change it in `vite.config.ts` if the repository gets a different name.
