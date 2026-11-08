// Simulation: player movement and stamina, the node switches, and the
// hunter that patrols the streets and chases what it sees or hears.
// No rendering or DOM. Events queue up for the interface to drain.

import {
  createCity,
  intersection,
  mulberry32,
  nearestIntersection,
  terminalRect,
  clamp,
  type City,
  type Rect,
  type Vec2,
} from "./city.ts";

export const PLAYER = { radius: 0.45, walk: 4, sprint: 7, eye: 1.7, reach: 2.4 };
export const STAMINA = { max: 100, drain: 22, regen: 14, recover: 30 };
export const HUNTER = {
  radius: 0.6,
  catchDistance: 1.6,
  wanderSpeed: 2.4,
  huntSpeed: 4.3,
  // Each shutdown adds this much to the hunt speed.
  huntGain: 0.5,
  loseAfter: 3,
  searchWait: 2.5,
  seeLit: 36,
  seeDark: 14,
  hearSprint: 24,
  hearWalk: 9,
};
export const SHUTDOWN_HOLD = 3;
const STRIDE = 2.1;
const LOOK_SENSITIVITY = 0.0022;

export type Input = { forward: number; strafe: number; sprint: boolean; interact: boolean };
export type Status = "ready" | "playing" | "paused" | "won" | "caught";
export type HunterState = "wander" | "hunt" | "search";
export type GameEvent =
  | { type: "step"; sprinting: boolean }
  | { type: "flashlight"; on: boolean }
  | { type: "shutdown"; node: number; remaining: number }
  | { type: "spotted" }
  | { type: "caught" }
  | { type: "won"; time: number };

export class Game {
  readonly city: City;
  status: Status = "ready";
  elapsed = 0;
  player: Vec2 & { yaw: number; pitch: number; moving: boolean; sprinting: boolean };
  stamina = STAMINA.max;
  exhausted = false;
  flashlight = true;
  hunter: Vec2 & {
    state: HunterState;
    sees: boolean;
    goal: Vec2 | null;
    path: Vec2[];
    lostFor: number;
    waitFor: number;
  };
  nodes: { lit: boolean; progress: number }[];
  shutdowns = 0;
  /** Index of the lit node within reach, if any. */
  activeNode: number | null = null;
  events: GameEvent[] = [];
  private stride = 0;
  private readonly solids: Rect[];
  private readonly rand: () => number;

  constructor(seed = 1) {
    this.city = createCity(seed);
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    this.solids = [...this.city.buildings, ...this.city.nodes.map(terminalRect)];
    this.player = { ...this.city.spawn, yaw: 0, pitch: 0, moving: false, sprinting: false };
    this.hunter = {
      ...this.city.hunterSpawn,
      state: "wander",
      sees: false,
      goal: null,
      path: [],
      lostFor: 0,
      waitFor: 0,
    };
    this.nodes = this.city.nodes.map(() => ({ lit: true, progress: 0 }));
  }

  get remaining(): number {
    return this.nodes.filter((n) => n.lit).length;
  }

  start() {
    if (this.status === "ready") this.status = "playing";
  }

  pause() {
    if (this.status === "playing") this.status = "paused";
  }

  resume() {
    if (this.status === "paused") this.status = "playing";
  }

  look(dx: number, dy: number) {
    if (this.status !== "playing") return;
    this.player.yaw -= dx * LOOK_SENSITIVITY;
    this.player.pitch = clamp(this.player.pitch - dy * LOOK_SENSITIVITY, -1.4, 1.4);
  }

  toggleFlashlight() {
    if (this.status !== "playing") return;
    this.flashlight = !this.flashlight;
    this.events.push({ type: "flashlight", on: this.flashlight });
  }

  step(dt: number, input: Input) {
    if (this.status !== "playing") return;
    this.elapsed += dt;
    this.movePlayer(dt, input);
    this.operateSwitch(dt, input.interact);
    if (this.status === "playing") this.moveHunter(dt);
  }

  private movePlayer(dt: number, input: Input) {
    const p = this.player;
    let mx = -Math.sin(p.yaw) * input.forward + Math.cos(p.yaw) * input.strafe;
    let mz = -Math.cos(p.yaw) * input.forward - Math.sin(p.yaw) * input.strafe;
    const len = Math.hypot(mx, mz);
    p.moving = len > 0.01;
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    p.sprinting = p.moving && input.sprint && !this.exhausted;
    const speed = p.sprinting ? PLAYER.sprint : PLAYER.walk;
    if (p.moving) {
      p.x += mx * speed * dt;
      p.z += mz * speed * dt;
      resolveCircle(p, PLAYER.radius, this.solids);
      const limit = this.city.half - PLAYER.radius;
      p.x = clamp(p.x, -limit, limit);
      p.z = clamp(p.z, -limit, limit);
      this.stride += speed * dt;
      if (this.stride >= STRIDE) {
        this.stride -= STRIDE;
        this.events.push({ type: "step", sprinting: p.sprinting });
      }
    }
    if (p.sprinting) {
      this.stamina = Math.max(0, this.stamina - STAMINA.drain * dt);
      if (this.stamina === 0) this.exhausted = true;
    } else {
      this.stamina = Math.min(STAMINA.max, this.stamina + STAMINA.regen * dt);
      if (this.exhausted && this.stamina >= STAMINA.recover) this.exhausted = false;
    }
  }

  private operateSwitch(dt: number, holding: boolean) {
    const p = this.player;
    this.activeNode = null;
    this.city.nodes.forEach((site, i) => {
      if (this.nodes[i].lit && Math.hypot(site.x - p.x, site.z - p.z) <= PLAYER.reach) {
        this.activeNode = i;
      }
    });
    this.nodes.forEach((n, i) => {
      if (!n.lit) return;
      if (i === this.activeNode && holding) {
        n.progress += dt;
        if (n.progress >= SHUTDOWN_HOLD) this.shutdown(i);
      } else {
        // Letting go loses progress fast. The hold is a commitment.
        n.progress = Math.max(0, n.progress - 2 * dt);
      }
    });
  }

  private shutdown(index: number) {
    const node = this.nodes[index];
    node.lit = false;
    node.progress = SHUTDOWN_HOLD;
    this.shutdowns++;
    const remaining = this.remaining;
    this.events.push({ type: "shutdown", node: index, remaining });
    if (remaining === 0) {
      this.status = "won";
      this.events.push({ type: "won", time: this.elapsed });
      return;
    }
    // The grid notices. The hunter heads for where the switch was thrown.
    const h = this.hunter;
    h.state = "search";
    h.goal = { x: this.player.x, z: this.player.z };
    h.path = [];
    h.lostFor = 0;
    h.waitFor = 0;
  }

  private moveHunter(dt: number) {
    const h = this.hunter;
    const p = this.player;
    const distance = Math.hypot(p.x - h.x, p.z - h.z);
    const los = hasLineOfSight(h, p, this.city.buildings);
    const seeRange = this.flashlight ? HUNTER.seeLit : HUNTER.seeDark;
    const hearRange = p.sprinting ? HUNTER.hearSprint : p.moving ? HUNTER.hearWalk : 0;
    h.sees = (los && distance < seeRange) || distance < hearRange;
    if (h.sees) {
      if (h.state !== "hunt") this.events.push({ type: "spotted" });
      h.state = "hunt";
      h.goal = { x: p.x, z: p.z };
      h.path = [];
      h.lostFor = 0;
    }
    const huntSpeed = HUNTER.huntSpeed + HUNTER.huntGain * this.shutdowns;
    switch (h.state) {
      case "hunt":
        if (h.sees && los) {
          this.advance(h, p, huntSpeed, dt);
        } else {
          this.travel(huntSpeed, dt);
          h.lostFor += dt;
          if (h.lostFor > HUNTER.loseAfter) {
            h.state = "search";
            h.waitFor = 0;
          }
        }
        break;
      case "search":
        if (this.travel(huntSpeed * 0.8, dt)) {
          h.waitFor += dt;
          if (h.waitFor > HUNTER.searchWait) {
            h.state = "wander";
            h.goal = null;
          }
        }
        break;
      case "wander":
        if (!h.goal || this.travel(HUNTER.wanderSpeed + 0.15 * this.shutdowns, dt)) {
          h.goal = this.wanderGoal();
          h.path = [];
        }
        break;
    }
    if (Math.hypot(p.x - h.x, p.z - h.z) < HUNTER.catchDistance) {
      this.status = "caught";
      this.events.push({ type: "caught" });
    }
  }

  /** Moves the hunter along the streets toward its goal. True on arrival. */
  private travel(speed: number, dt: number): boolean {
    const h = this.hunter;
    const goal = h.goal;
    if (!goal || Math.hypot(goal.x - h.x, goal.z - h.z) < 1) return true;
    const walls = this.city.buildings;
    if (h.path.length === 0 && !hasLineOfSight(h, goal, walls)) h.path = this.route(h, goal);
    // Drop waypoints we can already see past.
    while (h.path.length && hasLineOfSight(h, h.path[1] ?? goal, walls)) h.path.shift();
    this.advance(h, h.path[0] ?? goal, speed, dt);
    return false;
  }

  /** Intersections from one point to another, one straight run then a turn. */
  private route(from: Vec2, to: Vec2): Vec2[] {
    const city = this.city;
    const a = nearestIntersection(city, from);
    const b = nearestIntersection(city, to);
    const points: Vec2[] = [intersection(city, a.i, a.j)];
    let { i, j } = a;
    const walkI = () => {
      while (i !== b.i) points.push(intersection(city, (i += Math.sign(b.i - i)), j));
    };
    const walkJ = () => {
      while (j !== b.j) points.push(intersection(city, i, (j += Math.sign(b.j - j))));
    };
    if (this.rand() < 0.5) {
      walkI();
      walkJ();
    } else {
      walkJ();
      walkI();
    }
    return points;
  }

  /** Half the time the hunter drifts toward the player's part of town. */
  private wanderGoal(): Vec2 {
    const city = this.city;
    const towardPlayer = this.rand() < 0.5;
    const near = nearestIntersection(city, towardPlayer ? this.player : this.hunter);
    const spread = towardPlayer ? 2 : 3;
    const jitter = () => Math.round((this.rand() * 2 - 1) * spread);
    return intersection(
      city,
      clamp(near.i + jitter(), 0, city.blocks),
      clamp(near.j + jitter(), 0, city.blocks),
    );
  }

  private advance(e: Vec2, target: Vec2, speed: number, dt: number) {
    const dx = target.x - e.x;
    const dz = target.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    const s = Math.min(d, speed * dt);
    e.x += (dx / d) * s;
    e.z += (dz / d) * s;
    resolveCircle(e, HUNTER.radius, this.city.buildings);
  }
}

/** Pushes a circle out of any rectangle it overlaps, along the shorter axis. */
export function resolveCircle(p: Vec2, radius: number, rects: Rect[]) {
  for (const r of rects) {
    const hx = r.w / 2 + radius;
    const hz = r.d / 2 + radius;
    const dx = p.x - r.x;
    const dz = p.z - r.z;
    if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) continue;
    const px = hx - Math.abs(dx);
    const pz = hz - Math.abs(dz);
    if (px < pz) p.x += (dx < 0 ? -1 : 1) * px;
    else p.z += (dz < 0 ? -1 : 1) * pz;
  }
}

/** Liang-Barsky segment against an axis-aligned rectangle. */
export function segmentHitsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const edges: [number, number][] = [
    [-dx, a.x - (r.x - r.w / 2)],
    [dx, r.x + r.w / 2 - a.x],
    [-dz, a.z - (r.z - r.d / 2)],
    [dz, r.z + r.d / 2 - a.z],
  ];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

export function hasLineOfSight(a: Vec2, b: Vec2, walls: Rect[]): boolean {
  return !walls.some((r) => segmentHitsRect(a, b, r));
}
