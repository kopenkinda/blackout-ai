// Rendering: the dark city, the glowing node buildings, the hunter, and the
// player's flashlight. Reads game state every frame and never changes it.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  intersection,
  mulberry32,
  TERMINAL,
  type Building,
  type City,
  type NodeSite,
} from "./city.ts";
import { PLAYER, SHUTDOWN_HOLD, type Game } from "./game.ts";

export type SceneView = { render(game: Game, dt: number): void };

const SKY = 0x05060b;
const NODE_COLOR = 0x7df9ff;
const EYE = { r: 1, g: 0.16, b: 0.16 };
/** World units covered by one facade texture tile: four windows by four floors. */
const TILE = { w: 8, h: 10 };

export function createScene(mount: HTMLElement, city: City): SceneView {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.FogExp2(SKY, 0.014);

  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 900);
  camera.rotation.order = "YXZ";
  scene.add(camera);

  scene.add(new THREE.HemisphereLight(0x1b2342, 0x000000, 0.85));

  const flashlight = new THREE.SpotLight(0xfff1d6, 260, 60, 0.42, 0.5, 1.6);
  flashlight.position.set(0.25, -0.2, 0);
  flashlight.target.position.set(0, -0.6, -10);
  camera.add(flashlight, flashlight.target);

  const textures = makeTextures();
  scene.add(ground(city, textures), stars(), skyline(city, textures.facade), lampPosts(city));
  const nodes = city.nodes.map((site) => makeNode(city, site, textures, scene));
  const hunter = makeHunter(scene, textures);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = mount;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(mount);
  resize();

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let time = 0;
  let bob = 0;
  let yaw = 0;
  let pitch = 0;

  return {
    render(game, dt) {
      time += dt;
      const p = game.player;
      const h = game.hunter;
      if (p.moving && game.status === "playing" && !reducedMotion) {
        bob += dt * (p.sprinting ? 11 : 7.5);
      }
      if (game.status === "caught") {
        // Turn to face the thing that found you.
        const toward = Math.atan2(-(h.x - p.x), -(h.z - p.z));
        yaw += shortestTurn(yaw, toward) * Math.min(1, dt * 6);
        pitch += (0.3 - pitch) * Math.min(1, dt * 6);
      } else {
        yaw = p.yaw;
        pitch = p.pitch;
      }
      camera.position.set(p.x, PLAYER.eye + Math.sin(bob) * 0.035, p.z);
      camera.rotation.set(pitch, yaw, 0);
      flashlight.visible = game.flashlight;
      flashlight.intensity = 260 * (0.95 + 0.05 * Math.sin(time * 37) * Math.sin(time * 11));

      game.nodes.forEach((n, i) => nodes[i].update(n, dt, time));
      hunter.update(game, dt, time);
      renderer.render(scene, camera);
    },
  };
}

function shortestTurn(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

type Textures = ReturnType<typeof makeTextures>;

function makeTextures() {
  const rand = mulberry32(7);
  const canvas = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d")!);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const cell = 64;
  const eachWindow = (f: (x: number, y: number) => void) => {
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) f(x * cell, y * cell);
  };
  const facade = canvas(256, 256, (g) => {
    g.fillStyle = "#202229";
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2000; i++) {
      g.fillStyle = `rgba(0,0,0,${(rand() * 0.3).toFixed(2)})`;
      g.fillRect(rand() * 256, rand() * 256, 2, 2);
    }
    eachWindow((x, y) => {
      g.fillStyle = "#2c2f38";
      g.fillRect(x + 12, y + 10, 40, 42);
      g.fillStyle = `rgb(${9 + rand() * 5}, ${11 + rand() * 5}, ${18 + rand() * 8})`;
      g.fillRect(x + 15, y + 13, 34, 36);
    });
  });
  const windows = canvas(256, 256, (g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, 256, 256);
    eachWindow((x, y) => {
      if (rand() < 0.18) return;
      g.fillStyle = `rgba(255,255,255,${(0.45 + rand() * 0.55).toFixed(2)})`;
      g.fillRect(x + 15, y + 13, 34, 36);
    });
  });
  const asphalt = canvas(256, 256, (g) => {
    g.fillStyle = "#26262a";
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 6000; i++) {
      const v = Math.floor(25 + rand() * 30);
      g.fillStyle = `rgb(${v},${v},${v + 3})`;
      g.fillRect(rand() * 256, rand() * 256, 1.5, 1.5);
    }
  });
  const dash = canvas(8, 64, (g) => {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 8, 26);
  });
  const screen = (id: number) =>
    canvas(256, 160, (g) => {
      g.fillStyle = "#03110f";
      g.fillRect(0, 0, 256, 160);
      g.fillStyle = "#7df9ff";
      g.font = "bold 28px ui-monospace, Menlo, monospace";
      g.fillText(`NODE ${String(id + 1).padStart(2, "0")}`, 18, 44);
      g.font = "18px ui-monospace, Menlo, monospace";
      g.fillStyle = "#5ad7dd";
      const lines = ["LINK   ACTIVE", `LOAD   ${91 + ((id * 7) % 8)}%`, "POWER  LOCAL"];
      lines.forEach((line, i) => g.fillText(line, 18, 80 + i * 26));
      g.fillStyle = "#7df9ff";
      g.fillRect(200, 134, 14, 4);
      g.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = 0; y < 160; y += 3) g.fillRect(0, y, 256, 1);
    });
  const glow = canvas(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.35, "rgba(255,255,255,0.35)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  });
  // Alpha for the node beams: solid at the roof, gone at the top.
  const fade = canvas(4, 64, (g) => {
    const r = g.createLinearGradient(0, 0, 0, 64);
    r.addColorStop(0, "#000");
    r.addColorStop(1, "#fff");
    g.fillStyle = r;
    g.fillRect(0, 0, 4, 64);
  });
  return { facade, windows, asphalt, dash, screen, glow, fade };


}

/** A box with its texture scaled so windows stay the same size on every building. */
function buildingGeometry(b: Building): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(b.w, b.h, b.d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z. Four vertices each.
  const spans = [
    [b.d, b.h],
    [b.d, b.h],
    [b.w, b.d],
    [b.w, b.d],
    [b.w, b.h],
    [b.w, b.h],
  ];
  for (let i = 0; i < 24; i++) {
    const [su, sv] = spans[Math.floor(i / 4)];
    uv.setXY(i, (uv.getX(i) * su) / TILE.w, (uv.getY(i) * sv) / TILE.h);
  }
  g.translate(b.x, b.h / 2, b.z);
  return g;
}

function blockCenter(city: City, i: number, j: number) {
  const c = intersection(city, i, j);
  const o = city.streetWidth / 2 + city.blockSize / 2;
  return { x: c.x + o, z: c.z + o };
}

function ground(city: City, tex: Textures): THREE.Group {
  const group = new THREE.Group();
  const size = city.half * 2 + 400;
  tex.asphalt.repeat.set(size / 9, size / 9);
  const asphalt = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ map: tex.asphalt, roughness: 0.95 }),
  );
  asphalt.rotation.x = -Math.PI / 2;
  group.add(asphalt);

  // Raised sidewalks under every block.
  const slabs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < city.blocks; i++) {
    for (let j = 0; j < city.blocks; j++) {
      const c = blockCenter(city, i, j);
      const slab = new THREE.BoxGeometry(city.blockSize, 0.12, city.blockSize);
      slab.translate(c.x, 0.06, c.z);
      slabs.push(slab);
    }
  }
  group.add(
    new THREE.Mesh(
      mergeGeometries(slabs)!,
      new THREE.MeshStandardMaterial({ color: 0x3a3b41, roughness: 0.95 }),
    ),
  );

  // Faded lane lines down the middle of every street.
  const length = city.half * 2;
  tex.dash.repeat.set(1, length / 8);
  const dashMaterial = new THREE.MeshStandardMaterial({
    map: tex.dash,
    transparent: true,
    color: 0xd9cf9c,
    roughness: 0.9,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const dashGeometry = new THREE.PlaneGeometry(0.22, length);
  for (let k = 0; k <= city.blocks; k++) {
    const c = intersection(city, k, k);
    const along = new THREE.Mesh(dashGeometry, dashMaterial);
    along.rotation.set(-Math.PI / 2, 0, 0);
    along.position.set(c.x, 0.02, 0);
    const across = new THREE.Mesh(dashGeometry, dashMaterial);
    across.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    across.position.set(0, 0.02, c.z);
    group.add(along, across);
  }
  return group;
}

function stars(): THREE.Points {
  const rand = mulberry32(99);
  const count = 700;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(0.1 + rand() * 0.9);
    positions.set(
      [800 * Math.sin(phi) * Math.cos(theta), 800 * Math.cos(phi), 800 * Math.sin(phi) * Math.sin(theta)],
      i * 3,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0x9fb0ff,
      size: 1.8,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.55,
      fog: false,
    }),
  );
}

/** Every unpowered building, merged into one mesh. */
function skyline(city: City, facade: THREE.Texture): THREE.Mesh {
  const parts = city.buildings.filter((b) => b.node === null).map(buildingGeometry);
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return new THREE.Mesh(
    merged,
    new THREE.MeshStandardMaterial({ map: facade, roughness: 0.9, metalness: 0.05 }),
  );
}

/** Dead street lamps at every block corner. */
function lampPosts(city: City): THREE.Mesh {
  const pole = new THREE.CylinderGeometry(0.08, 0.12, 7, 6);
  pole.translate(0, 3.5, 0);
  const head = new THREE.BoxGeometry(0.9, 0.22, 0.32);
  head.translate(0.4, 7, 0);
  const lamp = mergeGeometries([pole, head])!;
  const parts: THREE.BufferGeometry[] = [];
  const off = city.blockSize / 2 - 0.8;
  for (let i = 0; i < city.blocks; i++) {
    for (let j = 0; j < city.blocks; j++) {
      const c = blockCenter(city, i, j);
      for (const kx of [-1, 1]) {
        for (const kz of [-1, 1]) {
          const g = lamp.clone();
          g.rotateY(Math.atan2(-kz, kx));
          g.translate(c.x + kx * off, 0, c.z + kz * off);
          parts.push(g);
        }
      }
    }
  }
  return new THREE.Mesh(
    mergeGeometries(parts)!,
    new THREE.MeshStandardMaterial({ color: 0x15161b, metalness: 0.6, roughness: 0.5 }),
  );
}

function makeNode(city: City, site: NodeSite, tex: Textures, scene: THREE.Scene) {
  const b = city.buildings[site.building];
  const material = new THREE.MeshStandardMaterial({
    map: tex.facade,
    emissiveMap: tex.windows,
    emissive: new THREE.Color(NODE_COLOR),
    emissiveIntensity: 1.3,
    roughness: 0.85,
    // Visible from across the city, like lit windows on a clear night.
    fog: false,
  });
  const building = new THREE.Mesh(buildingGeometry(b), material);

  const beamMaterial = new THREE.MeshBasicMaterial({
    color: NODE_COLOR,
    transparent: true,
    opacity: 0.12,
    alphaMap: tex.fade,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 4, 300, 16, 1, true), beamMaterial);
  beam.position.set(b.x, b.h + 150, b.z);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3030, fog: false }),
  );
  beacon.position.set(b.x - b.w / 2 + 1, b.h + 0.3, b.z - b.d / 2 + 1);

  const glow = new THREE.PointLight(NODE_COLOR, 90, 55, 2);
  glow.position.set(site.x + site.facing.x * 4, 6, site.z + site.facing.z * 4);

  const terminal = new THREE.Group();
  terminal.position.set(site.x, 0, site.z);
  terminal.rotation.y = Math.atan2(site.facing.x, site.facing.z);
  const rack = new THREE.Mesh(
    new THREE.BoxGeometry(TERMINAL.w, TERMINAL.h, TERMINAL.d),
    new THREE.MeshStandardMaterial({ color: 0x1a1d23, metalness: 0.7, roughness: 0.35 }),
  );
  rack.position.y = TERMINAL.h / 2;
  const screenMaterial = new THREE.MeshBasicMaterial({ map: tex.screen(site.id) });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.56), screenMaterial);
  screen.position.set(0, 1.42, TERMINAL.d / 2 + 0.006);
  const ledMaterial = new THREE.MeshBasicMaterial({ color: 0x4dff88 });
  const ledGeometry = new THREE.BoxGeometry(0.06, 0.06, 0.02);
  const leds = Array.from({ length: 6 }, (_, i) => {
    const led = new THREE.Mesh(ledGeometry, ledMaterial);
    led.position.set(-0.35 + i * 0.14, 0.9, TERMINAL.d / 2 + 0.01);
    return led;
  });
  const light = new THREE.PointLight(NODE_COLOR, 50, 36, 2);
  light.position.set(0, 2.8, 1.4);
  terminal.add(rack, screen, light, ...leds);

  scene.add(building, beam, beacon, glow, terminal);

  let level = 1;
  return {
    update(n: { lit: boolean; progress: number }, dt: number, time: number) {
      level += ((n.lit ? 1 : 0) - level) * Math.min(1, dt * 2.5);
      if (!n.lit && level < 0.02) level = 0;
      // The power stutters while the switch is held.
      const held = n.lit && n.progress > 0;
      const stutter = held && Math.random() < 0.25 + (n.progress / SHUTDOWN_HOLD) * 0.4 ? 0.25 : 1;
      const v = level * stutter * (0.92 + 0.08 * Math.sin(time * 23 + site.id));
      material.emissiveIntensity = 1.3 * v;
      beamMaterial.opacity = 0.12 * v;
      light.intensity = 50 * v;
      glow.intensity = 90 * v;
      screenMaterial.color.setScalar(v > 0.3 ? 1 : 0.02);
      ledMaterial.color.setHex(v > 0.3 ? 0x4dff88 : 0x200000);
      beacon.visible = n.lit && Math.sin(time * 3 + site.id) > 0.6;
      if (level === 0 && !material.fog) {
        material.fog = true;
        material.needsUpdate = true;
        beam.visible = false;
      }
    },
  };
}

function makeHunter(scene: THREE.Scene, tex: Textures) {
  const rand = mulberry32(5);
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x08080c, metalness: 0.9, roughness: 0.25 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.6, 0.32), shell);
  body.position.y = 2.2;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.46, 0.5), shell);
  head.position.y = 3.76;
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(EYE.r, EYE.g, EYE.b) });
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.07, 0.02), eyeMaterial);
  eye.position.set(0, 3.76, 0.26);
  // The glow ignores fog, so the eye shows as a red point from far away.
  const glowMaterial = new THREE.SpriteMaterial({
    map: tex.glow,
    color: 0xff2a2a,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.set(0, 3.76, 0.3);
  glow.scale.set(1.1, 0.9, 1);
  const light = new THREE.PointLight(0xff2a2a, 12, 16, 2);
  light.position.set(0, 3.7, 0.5);
  group.add(body, head, eye, glow, light);
  // Loose cables hang from the base and never quite reach the ground.
  for (let i = 0; i < 6; i++) {
    const length = 0.5 + rand() * 0.7;
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, length, 4), shell);
    cable.position.set((rand() - 0.5) * 0.4, 0.9 - length / 2, (rand() - 0.5) * 0.22);
    cable.rotation.z = (rand() - 0.5) * 0.25;
    group.add(cable);
  }
  scene.add(group);

  let yaw = 0;
  let level = 1;
  const last = { x: NaN, z: NaN };
  return {
    update(game: Game, dt: number, time: number) {
      const h = game.hunter;
      const p = game.player;
      if (game.status === "won") level = Math.max(0, level - dt * 0.7);
      const dx = h.x - last.x;
      const dz = h.z - last.z;
      if (game.status === "caught") {
        yaw += shortestTurn(yaw, Math.atan2(p.x - h.x, p.z - h.z)) * Math.min(1, dt * 10);
      } else if (!Number.isNaN(last.x) && Math.hypot(dx, dz) > 1e-3) {
        yaw += shortestTurn(yaw, Math.atan2(dx, dz)) * Math.min(1, dt * 8);
      }
      last.x = h.x;
      last.z = h.z;

      // It never holds quite still up close.
      const near = Math.hypot(p.x - h.x, p.z - h.z);
      const glitch = near < 18 && Math.random() < 0.12 ? 0.18 : 0;
      const jitter = () => (Math.random() - 0.5) * glitch;
      group.position.set(h.x + jitter(), Math.sin(time * 2) * 0.08 + jitter(), h.z + jitter());
      group.rotation.y = yaw;

      const hunting = h.state === "hunt";
      const pulse = hunting ? 1 + 0.35 * Math.sin(time * 14) : 1;
      const k = (hunting ? 1.6 : 1) * pulse * level;
      light.intensity = (hunting ? 34 : 12) * pulse * level;
      eyeMaterial.color.setRGB(EYE.r * k, EYE.g * k, EYE.b * k);
      glowMaterial.opacity = Math.min(1, 0.6 * k);
    },
  };
}
