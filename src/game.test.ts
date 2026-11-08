import test from "node:test";
import assert from "node:assert/strict";
import { Game, HUNTER, PLAYER, type Input } from "./game.ts";

const idle: Input = { forward: 0, strafe: 0, sprint: false, interact: false };
const run = (game: Game, seconds: number, input: Input) => {
  for (let t = 0; t < seconds; t += 1 / 60) game.step(1 / 60, input);
};
const started = (seed = 3) => {
  const game = new Game(seed);
  game.start();
  return game;
};
const standAtSwitch = (game: Game, node: number) => {
  const site = game.city.nodes[node];
  game.player.x = site.x + site.facing.x * 1.2;
  game.player.z = site.z + site.facing.z * 1.2;
};

test("walking into a building stops at its wall", () => {
  const game = started();
  const b = game.city.buildings
    .filter((b) => b.node === null)
    .sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
  const wall = b.x - b.w / 2;
  Object.assign(game.player, { x: wall - 1, z: b.z, yaw: -Math.PI / 2 });
  run(game, 2, { ...idle, forward: 1 });
  assert.ok(game.player.x <= wall - PLAYER.radius + 1e-6, "player passed into the wall");
  assert.ok(game.player.x > wall - 1.5, "player did not move toward the wall");
});

test("holding the switch for three seconds shuts a node down and alerts the hunter", () => {
  const game = started();
  standAtSwitch(game, 0);
  run(game, 1.5, { ...idle, interact: true });
  run(game, 1, idle);
  assert.equal(game.nodes[0].lit, true, "letting go should keep the node lit");
  assert.equal(game.nodes[0].progress, 0);

  run(game, 3.1, { ...idle, interact: true });
  assert.equal(game.nodes[0].lit, false);
  assert.equal(game.remaining, 5);
  assert.equal(game.hunter.state, "search");
  assert.deepEqual(game.hunter.goal, { x: game.player.x, z: game.player.z });
  const shutdown = game.events.find((e) => e.type === "shutdown");
  assert.deepEqual(shutdown, { type: "shutdown", node: 0, remaining: 5 });
});

test("shutting down every node wins", () => {
  const game = started();
  for (let i = 0; i < game.nodes.length; i++) {
    Object.assign(game.hunter, game.city.hunterSpawn, { state: "wander", goal: null });
    standAtSwitch(game, i);
    run(game, 3.1, { ...idle, interact: true });
  }
  assert.equal(game.status, "won");
  assert.equal(game.remaining, 0);
  assert.ok(game.events.some((e) => e.type === "won"));
});

test("the hunter sees down an open street but not around a corner", () => {
  const open = started();
  Object.assign(open.hunter, { x: open.player.x, z: open.player.z - 30 });
  open.step(1 / 60, idle);
  assert.equal(open.hunter.sees, true);
  assert.equal(open.hunter.state, "hunt");

  const corner = started();
  Object.assign(corner.hunter, { x: corner.player.x + 30, z: corner.player.z + 12 });
  corner.step(1 / 60, idle);
  assert.equal(corner.hunter.sees, false);
  assert.equal(corner.hunter.state, "wander");
});

test("a hunter with a clear line catches a standing player", () => {
  const game = started();
  Object.assign(game.hunter, { x: game.player.x, z: game.player.z - 10 });
  run(game, (10 - HUNTER.catchDistance) / HUNTER.huntSpeed + 0.5, idle);
  assert.equal(game.status, "caught");
  const types = game.events.map((e) => e.type);
  assert.ok(types.indexOf("spotted") < types.indexOf("caught"));
});
