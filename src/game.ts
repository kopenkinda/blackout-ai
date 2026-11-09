// Simulation: player movement and stamina, the node switches, and the four
// hunters that patrol the streets and chase what they see or hear.
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
  /** Added to every hunter's speeds per shutdown. */
  huntGain: 0.25,
  wanderGain: 0.1,
  searchWait: 2.5,
  seeLit: 36,
  seeDark: 14,
  hearSprint: 24,
  hearWalk: 9,
};
/** The grid sends the nearest idle hunter toward the player on this cadence. */
export const SWEEP = { first: 20, every: 28, faster: 3, min: 12 };
export const SHUTDOWN_HOLD = 3;
const STRIDE = 2.1;
const LOOK_SENSITIVITY = 0.0022;

export type HunterProfile = {
  name: string;
  /** Which lab it is a nod to. Drives the look. */
  maker: "claude" | "codex";
  /** Shown when it catches you. */
  line: string;
  wander: number;
  hunt: number;
  /** Multipliers on the shared sight and hearing ranges. */
  sight: number;
  hearing: number;
  /** Seconds without a line of sight before it gives up the chase. */
  loseAfter: number;
  /** Seconds ahead it guesses your position when it loses you. */
  predict: number;
};

export const PROFILES: HunterProfile[] = [
  {
    name: "OPUS",
    maker: "claude",
    line: "It was never going to stop.",
    wander: 2.2,
    hunt: 4,
    sight: 1,
    hearing: 1,
    loseAfter: 7,
    predict: 0,
  },
  {
    name: "FABLE",
    maker: "claude",
    line: "It guessed where you were going. It guessed right.",
    wander: 3.2,
    hunt: 5.2,
    sight: 0.8,
    hearing: 0.8,
    loseAfter: 2,
    predict: 3,
  },
  {
    name: "SOL",
    maker: "codex",
    line: "You saw its light. It saw yours.",
    wander: 2.4,
    hunt: 4.4,
    sight: 1.5,
    hearing: 0.5,
    loseAfter: 4,
    predict: 0,
  },
  {
    name: "ASTRA",
    maker: "codex",
    line: "It heard you long before it saw you.",
    wander: 2.6,
    hunt: 4.6,
    sight: 0.6,
    hearing: 1.9,
    loseAfter: 3,
    predict: 0,
  },
];

export type Input = { forward: number; strafe: number; sprint: boolean; interact: boolean };
export type Status = "ready" | "playing" | "paused" | "won" | "caught";
export type HunterState = "wander" | "hunt" | "search";
export type Hunter = Vec2 & {
  profile: HunterProfile;
  state: HunterState;
  sees: boolean;
  goal: Vec2 | null;
  path: Vec2[];
  lostFor: number;
  waitFor: number;
  /** Seconds spent not moving while trying to. Breaks pathing dead ends. */
  stuckFor: number;
};
export type GameEvent =
  | { type: "step"; sprinting: boolean }
  | { type: "flashlight"; on: boolean }
  | { type: "shutdown"; node: number; remaining: number }
  | { type: "spotted"; hunter: number }
  | { type: "caught"; hunter: number }
  | { type: "won"; time: number };

export class Game {
  readonly city: City;
  status: Status = "ready";
  elapsed = 0;
  player: Vec2 & {
    yaw: number;
    pitch: number;
    vx: number;
    vz: number;
    moving: boolean;
    sprinting: boolean;
  };
  stamina = STAMINA.max;
  exhausted = false;
  flashlight = true;
  hunters: Hunter[];
  caughtBy: number | null = null;
  nodes: { lit: boolean; progress: number }[];
  shutdowns = 0;
  /** Index of the lit node within reach, if any. */
  activeNode: number | null = null;
  events: GameEvent[] = [];
  private stride = 0;
  private sweepIn = SWEEP.first;
  /** What the player bumps into. */
  private readonly solids: Rect[];
  /** What the hunters bump into. They see over cars but not through buildings. */
  private readonly blockers: Rect[];
  private readonly rand: () => number;

  constructor(seed = 1) {
    this.city = createCity(seed);
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    this.blockers = [...this.city.buildings, ...this.city.cars];
    this.solids = [...this.blockers, ...this.city.nodes.map(terminalRect)];
    this.player = {
      ...this.city.spawn,
      yaw: 0,
      pitch: 0,
      vx: 0,
      vz: 0,
      moving: false,
      sprinting: false,
    };
    this.hunters = PROFILES.map((profile, i) => ({
      ...this.city.hunterSpawns[i % this.city.hunterSpawns.length],
      profile,
      state: "wander",
      sees: false,
      goal: null,
      path: [],
      lostFor: 0,
      waitFor: 0,
      stuckFor: 0,
    }));
    this.nodes = this.city.nodes.map(() => ({ lit: true, progress: 0 }));
  }

  get remaining(): number {
    return this.nodes.filter((n) => n.lit).length;
  }

  /** 0 to 1. How close the nearest hunter is, never below 0.4 while one is hunting. */
  get danger(): number {
    const p = this.player;
    const nearest = Math.min(...this.hunters.map((h) => Math.hypot(h.x - p.x, h.z - p.z)));
    const closeness = clamp(1 - (nearest - 3) / 38, 0, 1);
    return this.hunters.some((h) => h.state === "hunt") ? Math.max(closeness, 0.4) : closeness;
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
    if (this.status !== "playing") return;
    this.sweepIn -= dt;
    if (this.sweepIn <= 0) {
      this.sweep();
      this.sweepIn = Math.max(SWEEP.min, SWEEP.every - SWEEP.faster * this.shutdowns);
    }
    this.hunters.forEach((h, i) => {
      if (this.status === "playing") this.moveHunter(h, i, dt);
    });
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
    p.vx = p.moving ? mx * speed : 0;
    p.vz = p.moving ? mz * speed : 0;
    if (p.moving) {
      p.x += p.vx * dt;
      p.z += p.vz * dt;
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
    // The grid notices. Every hunter heads for where the switch was thrown.
    for (const h of this.hunters) this.send(h, { x: this.player.x, z: this.player.z });
  }

  /** The grid knows roughly where you are and sends the nearest idle hunter. */
  private sweep() {
    const p = this.player;
    const idle = this.hunters
      .filter((h) => h.state === "wander")
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    if (idle.length === 0) return;
    const near = nearestIntersection(this.city, p);
    const jitter = () => Math.round(this.rand() * 2 - 1);
    const goal = intersection(
      this.city,
      clamp(near.i + jitter(), 0, this.city.blocks),
      clamp(near.j + jitter(), 0, this.city.blocks),
    );
    this.send(idle[0], goal);
  }

  private send(h: Hunter, goal: Vec2) {
    h.state = "search";
    h.goal = goal;
    h.path = [];
    h.lostFor = 0;
    h.waitFor = 0;
    h.stuckFor = 0;
  }

  private moveHunter(h: Hunter, index: number, dt: number) {
    const p = this.player;
    const f = h.profile;
    const distance = Math.hypot(p.x - h.x, p.z - h.z);
    const los = hasLineOfSight(h, p, this.city.buildings);
    const seeRange = (this.flashlight ? HUNTER.seeLit : HUNTER.seeDark) * f.sight;
    const hearRange = (p.sprinting ? HUNTER.hearSprint : p.moving ? HUNTER.hearWalk : 0) * f.hearing;
    h.sees = (los && distance < seeRange) || distance < hearRange;
    if (h.sees) {
      if (h.state !== "hunt") this.events.push({ type: "spotted", hunter: index });
      h.state = "hunt";
      h.goal = this.onStreet({ x: p.x + p.vx * f.predict, z: p.z + p.vz * f.predict }) ?? { x: p.x, z: p.z };
      h.path = [];
      h.lostFor = 0;
    }
    const huntSpeed = f.hunt + HUNTER.huntGain * this.shutdowns;
    switch (h.state) {
      case "hunt":
        if (h.sees && los) {
          this.advance(h, p, huntSpeed, dt);
        } else {
          this.travel(h, huntSpeed, dt);
          h.lostFor += dt;
          if (h.lostFor > f.loseAfter) {
            h.state = "search";
            h.waitFor = 0;
          }
        }
        break;
      case "search":
        if (this.travel(h, huntSpeed * 0.8, dt)) {
          h.waitFor += dt;
          if (h.waitFor > HUNTER.searchWait) {
            h.state = "wander";
            h.goal = null;
          }
        }
        break;
      case "wander":
        if (!h.goal || this.travel(h, f.wander + HUNTER.wanderGain * this.shutdowns, dt)) {
          h.goal = this.wanderGoal(h);
          h.path = [];
        }
        break;
    }
    if (Math.hypot(p.x - h.x, p.z - h.z) < HUNTER.catchDistance) {
      this.status = "caught";
      this.caughtBy = index;
      this.events.push({ type: "caught", hunter: index });
    }
  }

  /** The point itself if a hunter could stand there, otherwise null. */
  private onStreet(point: Vec2): Vec2 | null {
    const limit = this.city.half - HUNTER.radius;
    if (Math.abs(point.x) > limit || Math.abs(point.z) > limit) return null;
    const blocked = this.blockers.some(
      (r) =>
        Math.abs(point.x - r.x) < r.w / 2 + HUNTER.radius &&
        Math.abs(point.z - r.z) < r.d / 2 + HUNTER.radius,
    );
    return blocked ? null : point;
  }

  /** Moves a hunter along the streets toward its goal. True on arrival. */
  private travel(h: Hunter, speed: number, dt: number): boolean {
    const goal = h.goal;
    if (!goal || Math.hypot(goal.x - h.x, goal.z - h.z) < 1) return true;
    if (h.stuckFor > 2) return true;
    const walls = this.city.buildings;
    if (h.path.length === 0 && !hasLineOfSight(h, goal, walls)) h.path = this.route(h, goal);
    // Drop waypoints we can already see past.
    while (h.path.length && hasLineOfSight(h, h.path[1] ?? goal, walls)) h.path.shift();
    const before = { x: h.x, z: h.z };
    this.advance(h, h.path[0] ?? goal, speed, dt);
    const moved = Math.hypot(h.x - before.x, h.z - before.z);
    h.stuckFor = moved < speed * dt * 0.2 ? h.stuckFor + dt : 0;
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

  /** Half the time a hunter drifts toward the player's part of town. */
  private wanderGoal(h: Hunter): Vec2 {
    const city = this.city;
    const towardPlayer = this.rand() < 0.5;
    const near = nearestIntersection(city, towardPlayer ? this.player : h);
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
    resolveCircle(e, HUNTER.radius, this.blockers);
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
