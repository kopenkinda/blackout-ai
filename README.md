# Blackout

A first-person horror game in a city with no power. An AI cut the grid and kept what it needed. Six nodes still glow. Find them, hold the switch until each one goes dark, and stay away from the thing patrolling the streets.

Built with TypeScript, Three.js, and Vite. The city, the nodes, the hunter, and every sound are generated in code. No models, textures, audio files, backend, or API keys.

## How to play

You start in the middle of an eight-by-eight grid of blocks. Lit buildings and the light columns above them mark the nodes. Walk up to the terminal in front of a node and hold E for three seconds. Let go early and the progress drains away.

Every shutdown does two things. The hunter gets faster, and it goes to look at the spot where you threw the switch. Shut down all six to win. If it reaches you, the round ends.

| Control | Action |
| --- | --- |
| W A S D, or the up and down arrows | Move |
| Mouse | Look (the page locks the pointer while you play) |
| Left and right arrows | Turn, if pointer lock is unavailable |
| Shift | Run. Stamina drains, then you have to wait for it to come back |
| E, or hold the mouse button | Shut down the node in front of you |
| F | Flashlight on or off |
| Escape | Pause |

The hunter sees you from about 36 meters with your flashlight on and about 14 with it off, as long as nothing stands between you. It hears running from 24 meters and walking from 9. It loses you a few seconds after you break line of sight, checks the last place it saw you, then goes back to patrolling. Half of its patrol targets are near you.

The edge of the screen turns red as it gets close. A heartbeat and a low growl do the same. Headphones help.

Your best time stays in your browser. Sound can be turned off from the start screen. The game needs a keyboard and a mouse. Touch controls are not in yet.

## Run locally

Use Node.js 24 and npm. Run these from the project directory:

```sh
npm ci
npm run dev
```

Open the URL Vite prints. The app lives under the `/slop-blackout/` path locally and in production. A browser with WebGL is required.

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
| [src/game.ts](src/game.ts) | Player movement and stamina, collision, the switches, and the hunter's patrol, chase, and search |
| [src/scene.ts](src/scene.ts) | Three.js rendering: the merged skyline, lit node buildings, terminals, the hunter, the flashlight, and fog |
| [src/audio.ts](src/audio.ts) | Web Audio synthesis for the ambience, hum, heartbeat, footsteps, and stings |
| [src/main.ts](src/main.ts) | Input, pointer lock, HUD, overlay screens, saved preferences, and the frame loop |
| [src/style.css](src/style.css) | HUD, vignette, and overlay styling |
| [index.html](index.html) | Page structure, HUD markup, and the overlay card |
| [src/game.test.ts](src/game.test.ts) | Collision, switch holds, winning, line of sight, and getting caught |
| [vite.config.ts](vite.config.ts) | Build path and chunking |
| [.github/workflows/deploy.yml](.github/workflows/deploy.yml) | GitHub Pages deployment |

The simulation in `game.ts` has no dependency on Three.js or the DOM. The tests run it directly with Node's test runner.

## Deployment

Every push to `main` installs dependencies, type-checks, runs the tests, builds the site, and deploys `dist/` to GitHub Pages. The Vite base path is set to `/slop-blackout/`. Change it in `vite.config.ts` if the repository gets a different name.
