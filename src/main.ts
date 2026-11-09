// Interface: keyboard and mouse input, pointer lock, the HUD, the overlay
// screens, saved preferences, and the frame loop.

import "./style.css";
import { clamp } from "./city.ts";
import { Game, PROFILES, SHUTDOWN_HOLD, STAMINA, type GameEvent, type Input } from "./game.ts";
import { createScene, WIN_SEQUENCE } from "./scene.ts";
import { createAudio } from "./audio.ts";

declare global {
  interface Window {
    __blackout?: { game: () => Game; step(dt?: number, frames?: number): void };
  }
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = el("stage");
const hud = el("hud");
const nodesEl = el("nodes");
const toast = el("toast");
const timer = el("timer");
const prompt = el("prompt");
const progress = el("progress");
const progressBar = progress.firstElementChild as HTMLElement;
const stamina = el("stamina");
const staminaBar = stamina.firstElementChild as HTMLElement;
const overlay = el("overlay");
const card = el("card");
const eyebrow = el("eyebrow");
const title = el("title");
const body = el("body");
const keyGuide = el("key-guide");
const note = el("note");
const primary = el<HTMLButtonElement>("primary");
const secondary = el<HTMLButtonElement>("secondary");
const bestEl = el("best");
const soundButton = el<HTMLButtonElement>("sound");

const store = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Private mode. Nothing saved. */
    }
  },
};

// One city per page load. Retrying keeps the same streets and node sites.
const seed = Math.floor(Math.random() * 1e6);
let game = new Game(seed);
const scene = createScene(stage, game.city);
const audio = createAudio();
for (const _ of game.nodes) nodesEl.appendChild(document.createElement("i"));

let muted = store.get("blackout-muted") === "1";
const applySound = () => {
  audio.setMuted(muted);
  soundButton.textContent = muted ? "Sound off" : "Sound on";
  soundButton.setAttribute("aria-pressed", String(!muted));
};
applySound();
soundButton.addEventListener("click", () => {
  muted = !muted;
  store.set("blackout-muted", muted ? "1" : "0");
  applySound();
});

const bestTime = () => Number(store.get("blackout-best")) || 0;
const format = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const titleCase = (name: string) => name[0] + name.slice(1).toLowerCase();

// Input

const input: Input = { forward: 0, strafe: 0, sprint: false, interact: false };
const down = new Set<string>();
let mouseHeld = false;
let turn = 0;
const has = (...codes: string[]) => codes.some((c) => down.has(c));
const readInput = () => {
  input.forward = +has("KeyW", "ArrowUp") - +has("KeyS", "ArrowDown");
  input.strafe = +has("KeyD") - +has("KeyA");
  input.sprint = has("ShiftLeft", "ShiftRight");
  input.interact = has("KeyE") || mouseHeld;
  turn = +has("ArrowLeft") - +has("ArrowRight");
};
const locked = () => document.pointerLockElement === stage;

addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "KeyF") game.toggleFlashlight();
  if (e.code === "Escape" && game.status === "playing") pause();
  if (["Space", "Enter", "Escape"].includes(e.code)) skipEnding();
  down.add(e.code);
  readInput();
  if (game.status === "playing" && e.code.startsWith("Arrow")) e.preventDefault();
});
addEventListener("keyup", (e) => {
  down.delete(e.code);
  readInput();
});
addEventListener("blur", () => {
  down.clear();
  mouseHeld = false;
  readInput();
});
stage.addEventListener("mousedown", () => {
  if (!locked()) return;
  mouseHeld = true;
  readInput();
});
addEventListener("mouseup", () => {
  mouseHeld = false;
  readInput();
});
addEventListener("mousemove", (e) => {
  if (locked()) game.look(e.movementX, e.movementY);
});
stage.addEventListener("click", () => {
  if (game.status === "playing" && !locked()) void lockPointer();
  skipEnding();
});
document.addEventListener("pointerlockchange", () => {
  if (!locked() && game.status === "playing") pause();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && game.status === "playing") pause();
});

async function lockPointer() {
  try {
    await stage.requestPointerLock();
  } catch {
    /* No pointer lock here. The arrow keys still turn. */
  }
}

// Screens

type Screen = "start" | "paused" | "caught" | "won";
let screen: Screen = "start";

function showOverlay(kind: Screen) {
  screen = kind;
  const time = format(game.elapsed);
  const best = bestTime();
  const names = PROFILES.map((p) => titleCase(p.name));
  const catcher = PROFILES[game.caughtBy ?? 0];
  const copy = {
    start: {
      eyebrow: "Grid status: dark",
      title: "BLACKOUT",
      body: `The AIs cut the city's power and kept what they needed. Six nodes still feed them. Walk up to each one and hold the switch until it goes dark. Four hunters patrol the streets: ${names.slice(0, -1).join(", ")}, and ${names.at(-1)}. Each finds you a different way. Every shutdown makes them faster, and they all come to look at the spot where you did it.`,
      button: "Begin",
    },
    paused: {
      eyebrow: "Paused",
      title: "Hold.",
      body: "The city is still dark. They are still out there.",
      button: "Resume",
    },
    caught: {
      eyebrow: "Connection terminated",
      title: `${titleCase(catcher.name)} found you.`,
      body: `${catcher.line} ${game.shutdowns} of ${game.nodes.length} nodes shut down. ${time} on the clock.`,
      button: "Try again",
    },
    won: {
      eyebrow: "All nodes offline",
      title: "The lights are back.",
      body: `Every node down in ${time}. The grid is the city's again. Nothing else is running now.`,
      button: "Play again",
    },
  }[kind];
  eyebrow.textContent = copy.eyebrow;
  title.textContent = copy.title;
  body.textContent = copy.body;
  primary.textContent = copy.button;
  card.classList.toggle("alarm", kind === "caught");
  keyGuide.hidden = kind !== "start";
  secondary.hidden = kind !== "paused";
  bestEl.textContent = best ? `Best ${format(best)}` : "";
  if (kind === "start" && matchMedia("(pointer: coarse)").matches) {
    note.textContent = "Needs a keyboard and a mouse. Touch controls are not in yet.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  overlay.hidden = false;
  hud.hidden = kind === "start";
  primary.focus();
}

async function play() {
  audio.unlock();
  if (game.status === "ready") game.start();
  else game.resume();
  overlay.hidden = true;
  hud.hidden = false;
  await lockPointer();
}

function pause() {
  game.pause();
  if (locked()) document.exitPointerLock();
  showOverlay("paused");
}

function restart() {
  game = new Game(seed);
  document.documentElement.style.setProperty("--danger", "0");
}

primary.addEventListener("click", () => {
  if (screen === "caught" || screen === "won") restart();
  void play();
});
secondary.addEventListener("click", () => {
  restart();
  void play();
});

// Per-frame interface

let toastTimer = 0;
function flash(text: string) {
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

let endTimer = 0;
function endRound(kind: "caught" | "won", delay: number) {
  clearTimeout(endTimer);
  endTimer = window.setTimeout(() => {
    if (locked()) document.exitPointerLock();
    showOverlay(kind);
  }, delay);
}

/** The ending can be cut short once its lights are on. */
function skipEnding() {
  if (game.status === "won" && overlay.hidden) endRound("won", 0);
}

function handle(e: GameEvent) {
  switch (e.type) {
    case "step":
      audio.step(e.sprinting);
      break;
    case "flashlight":
      audio.click();
      break;
    case "shutdown": {
      audio.shutdown();
      const id = String(e.node + 1).padStart(2, "0");
      flash(e.remaining ? `Node ${id} offline. ${e.remaining} left.` : `Node ${id} offline.`);
      break;
    }
    case "spotted":
      audio.spotted();
      break;
    case "caught":
      audio.caught();
      endRound("caught", 1400);
      break;
    case "won": {
      audio.won();
      const best = bestTime();
      if (!best || e.time < best) store.set("blackout-best", String(e.time));
      hud.hidden = true;
      endRound("won", WIN_SEQUENCE * 1000);
      break;
    }
  }
}

function updateHud(dt: number) {
  const p = game.player;
  game.nodes.forEach((n, i) => nodesEl.children[i].classList.toggle("off", !n.lit));
  timer.textContent = format(game.elapsed);

  const active = game.activeNode !== null && game.status === "playing";
  prompt.hidden = !active;
  progress.hidden = !active;
  if (active) {
    const width = (game.nodes[game.activeNode!].progress / SHUTDOWN_HOLD) * 100;
    progressBar.style.width = `${width}%`;
  }
  staminaBar.style.width = `${game.stamina}%`;
  stamina.classList.toggle("show", game.stamina < STAMINA.max - 0.5);
  stamina.classList.toggle("spent", game.exhausted);

  const danger = game.status === "playing" || game.status === "caught" ? game.danger : 0;
  document.documentElement.style.setProperty("--danger", danger.toFixed(3));

  const hum = Math.max(
    0,
    ...game.city.nodes.map((site, i) =>
      game.nodes[i].lit ? 1 - Math.hypot(site.x - p.x, site.z - p.z) / 30 : 0,
    ),
  );
  audio.update(dt, { hum: clamp(hum, 0, 1), danger: game.status === "playing" ? danger : 0 });
}

function tick(dt: number) {
  if (game.status === "playing") {
    if (turn) game.look(-turn * dt * 900, 0);
    game.step(dt, input);
  }
  for (const e of game.events) handle(e);
  game.events.length = 0;
  updateHud(dt);
  scene.render(game, dt);
}

let previous = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;
  tick(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
showOverlay("start");

if (import.meta.env.DEV) {
  window.__blackout = {
    game: () => game,
    step(dt = 1 / 60, frames = 1) {
      for (let i = 0; i < frames; i++) tick(dt);
    },
  };
}
