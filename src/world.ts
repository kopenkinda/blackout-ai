// The city as geometry: buildings and rooftops, storefronts, streets, parked
// cars, street lamps, and the six nodes. Static pieces are merged into a few
// meshes. The ending's power wave runs in the shaders: every powered vertex
// carries the point it belongs to, and lights up once the wave passes it.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  CAR,
  intersection,
  mulberry32,
  TERMINAL,
  type Building,
  type City,
  type NodeSite,
  type Vec2,
} from "./city.ts";
import { SHUTDOWN_HOLD, type Game } from "./game.ts";

/** Facade tile in world units: eight 2 m windows across, eight 3 m floors up. */
const FACADE = { w: 16, h: 24 };
/** Storefront tile: eight 8 m shop units, one storey tall. */
const SHOP = { w: 64, h: 4 };
/** Data-center tile: two floors of server hall glazing. */
const HALL = { w: 12, h: 6 };
const LAMP_LIGHT = new THREE.Color(1, 0.6, 0.28);

export function canvasTexture(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D) => void,
  color = true,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

let glow: THREE.Texture | undefined;
/** A soft white dot for halos, sprites, and pools of light. */
export function glowTexture(): THREE.Texture {
  glow ??= canvasTexture(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.35, "rgba(255,255,255,0.35)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  });
  return glow;
}

/**
 * A shaft of light for open cylinders and cones: brightest at its source and
 * along its middle, fading to nothing at the far end and the edges.
 * `source` is the end the light comes from, in the geometry's v coordinate.
 */
export function shaftMaterial(color: THREE.ColorRepresentation, source: 0 | 1) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      varying float vAlong;
      varying float vFacing;
      void main() {
        vAlong = ${source === 1 ? "uv.y" : "1.0 - uv.y"};
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-view.xyz)));
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlong;
      varying float vFacing;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity * vAlong * vAlong * vFacing * vFacing);
      }`,
  });
}

// The power wave

const power = {
  uPowerOrigin: { value: new THREE.Vector2() },
  uPowerRadius: { value: -1 },
  uTime: { value: 0 },
};

/**
 * Runs `code` in the material's fragment shader after `chunk`, with vPower
 * rising from 0 to 1 as the wave passes the geometry's aPower point
 * (x, z, delay). Things flicker while they come on.
 */
function powered<T extends THREE.Material>(material: T, chunk: string, code: string): T {
  material.customProgramCacheKey = () => code;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, power);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec3 aPower;
uniform vec2 uPowerOrigin;
uniform float uPowerRadius;
uniform float uTime;
varying float vPower;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vPower = clamp((uPowerRadius - distance(aPower.xy, uPowerOrigin) - aPower.z * 14.0) / 5.0, 0.0, 1.0);
if (vPower < 1.0) vPower *= step(0.5, fract(sin(floor(uTime * 16.0) + aPower.z * 97.0) * 43758.5));`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vPower;")
      .replace(chunk, `${chunk}\n${code}`);
  };
  return material;
}

/** Sets one constant value for an attribute on every vertex. */
function fill(g: THREE.BufferGeometry, name: string, ...values: number[]): THREE.BufferGeometry {
  const data = new Float32Array(g.attributes.position.count * values.length);
  for (let i = 0; i < data.length; i++) data[i] = values[i % values.length];
  g.setAttribute(name, new THREE.BufferAttribute(data, values.length));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  return merged;
}

/**
 * A box whose side texture repeats every `tile` world units, so windows keep
 * one size on any building. Top and bottom sample the single texel at `cap`.
 */
function tiledBox(
  w: number,
  h: number,
  d: number,
  tile: { w: number; h: number },
  offset: [number, number] = [0, 0],
  cap: [number, number] = [0.01, 0.01],
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z. Four vertices each.
  const spans = [d, d, 0, 0, w, w];
  for (let i = 0; i < 24; i++) {
    const face = Math.floor(i / 4);
    if (face === 2 || face === 3) uv.setXY(i, cap[0], cap[1]);
    else uv.setXY(i, (uv.getX(i) * spans[face]) / tile.w + offset[0], (uv.getY(i) * h) / tile.h + offset[1]);
  }
  return g;
}

function blockCenter(city: City, i: number, j: number): Vec2 {
  const c = intersection(city, i, j);
  const o = city.streetWidth / 2 + city.blockSize / 2;
  return { x: c.x + o, z: c.z + o };
}

function speckle(g: CanvasRenderingContext2D, rand: () => number, w: number, h: number, count: number) {
  for (let i = 0; i < count; i++) {
    const v = Math.floor(rand() * 255);
    g.fillStyle = `rgba(${v},${v},${v},${(rand() * 0.08).toFixed(3)})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

// Textures

type Style = "flats" | "office" | "tower";

/** Albedo, lit windows, and roughness for one facade style, on one 8 by 8 window grid. */
function facade(style: Style, seed: number) {
  const rand = mulberry32(seed);
  const S = 512;
  const C = 64;
  const wall = { flats: "#3d3530", office: "#3a3c41", tower: "#2e3036" }[style];
  // Panes inside a cell: x, y, width, height in pixels from the cell's top left.
  const panes = {
    flats: [[14, 10, 36, 40]],
    office: [[0, 16, 64, 34]],
    tower: [
      [9, 6, 16, 50],
      [39, 6, 16, 50],
    ],
  }[style];
  const tones = ["255,196,128", "255,222,180", "255,196,128", "255,222,180", "255,170,90", "205,222,255", "140,170,255"];
  const cells: { x: number; y: number; light: string | null; blinds: boolean; shape: number }[] = [];
  for (let cy = 0; cy < 8; cy++) {
    let previous = false;
    for (let cx = 0; cx < 8; cx++) {
      // Offices light up in runs along a floor. Homes are scattered.
      const on: boolean = style === "office" && cx > 0 ? rand() < (previous ? 0.8 : 0.3) : rand() > 0.3;
      previous = on;
      const tone = tones[Math.floor(rand() * tones.length)];
      cells.push({
        x: cx * C,
        y: cy * C,
        light: on ? `rgba(${tone},${(0.45 + rand() * 0.55).toFixed(2)})` : null,
        blinds: rand() < 0.2,
        shape: rand() < 0.3 ? rand() : -1,
      });
    }
  }
  const eachPane = (f: (x: number, y: number, w: number, h: number, cell: (typeof cells)[number]) => void) => {
    for (const cell of cells) for (const [px, py, pw, ph] of panes) f(cell.x + px, cell.y + py, pw, ph, cell);
  };

  const map = canvasTexture(S, S, (g) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, S, S);
    speckle(g, rand, S, S, 6000);
    if (style === "flats") {
      g.fillStyle = "rgba(0,0,0,0.13)";
      for (let y = 0; y < S; y += 8) g.fillRect(0, y, S, 1);
    } else {
      g.fillStyle = "rgba(255,255,255,0.05)";
      for (let y = 0; y < S; y += C) g.fillRect(0, y + 56, S, 5);
    }
    eachPane((x, y, w, h) => {
      g.fillStyle = "rgba(255,255,255,0.09)";
      g.fillRect(x - 2, y - 2, w + 4, h + 4);
      const glass = g.createLinearGradient(0, y, 0, y + h);
      glass.addColorStop(0, "#1c2333");
      glass.addColorStop(1, "#06080d");
      g.fillStyle = glass;
      g.fillRect(x, y, w, h);
      g.fillStyle = "rgba(255,255,255,0.1)";
      g.fillRect(x - 3, y + h + 2, w + 6, 2);
      if (style === "office") {
        g.fillStyle = "#16181c";
        for (let m = 0; m < w; m += 16) g.fillRect(x + m, y, 2, h);
      }
    });
    // Grime runs down from the sills.
    for (let i = 0; i < 50; i++) {
      g.fillStyle = `rgba(0,0,0,${(0.05 + rand() * 0.12).toFixed(2)})`;
      g.fillRect(rand() * S, rand() * S, 2 + rand() * 6, 30 + rand() * 140);
    }
  });

  const windows = canvasTexture(S, S, (g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, S, S);
    eachPane((x, y, w, h, cell) => {
      if (!cell.light) return;
      g.fillStyle = cell.light;
      g.fillRect(x, y, w, h);
      g.fillStyle = "rgba(0,0,0,0.55)";
      if (cell.blinds) for (let k = 2; k < h; k += 5) g.fillRect(x, y + k, w, 2);
      // Someone's furniture, a plant, a person standing at the glass.
      if (cell.shape >= 0) g.fillRect(x + cell.shape * w * 0.6, y + h * 0.4, w * 0.28, h * 0.6);
      if (style === "office") {
        g.fillStyle = "#000";
        for (let m = 0; m < w; m += 16) g.fillRect(x + m, y, 2, h);
      }
    });
  });

  const roughness = canvasTexture(
    S,
    S,
    (g) => {
      g.fillStyle = "rgb(235,235,235)";
      g.fillRect(0, 0, S, S);
      g.fillStyle = "rgb(160,160,160)";
      eachPane((x, y, w, h) => g.fillRect(x, y, w, h));
    },
    false,
  );
  return { map, windows, roughness };
}

const SHOP_NAMES = ["PHARMACY", "NOODLES", "LAUNDRY", "24H", "MARKET", "DELI", "PAWN", "BAR", "REPAIR", "CAFE", "VIDEO", "BAKERY"];
const SIGN_COLORS = ["#ff4b3e", "#ffb347", "#57ff9a", "#f4f4ff", "#ff5fd2", "#5fd0ff"];
const GRAFFITI = ["PULL THE PLUG", "LIGHTS OUT", "IT LISTENS", "OFFLINE", "DONT RUN"];
const SPRAY = ["rgba(230,60,90,0.6)", "rgba(80,180,255,0.55)", "rgba(240,240,240,0.5)", "rgba(255,205,40,0.55)"];

/** Ground floor: eight shop units with signs, mostly behind rolled-down shutters. */
function storefronts() {
  const rand = mulberry32(41);
  const W = 2048;
  const H = 128;
  const units = Array.from({ length: 8 }, (_, u) => ({
    x: u * 256,
    name: SHOP_NAMES[Math.floor(rand() * SHOP_NAMES.length)],
    color: SIGN_COLORS[Math.floor(rand() * SIGN_COLORS.length)],
    shutter: rand() < 0.75,
    tag: rand() < 0.6 ? GRAFFITI[Math.floor(rand() * GRAFFITI.length)] : null,
    spray: SPRAY[Math.floor(rand() * SPRAY.length)],
  }));
  const lettering = (g: CanvasRenderingContext2D, x: number, name: string) => {
    g.font = "bold 19px ui-sans-serif, Helvetica, Arial, sans-serif";
    g.textBaseline = "middle";
    g.fillText(name, x + 30, 16);
  };

  const map = canvasTexture(W, H, (g) => {
    g.fillStyle = "#2a2b2f";
    g.fillRect(0, 0, W, H);
    speckle(g, rand, W, H, 3000);
    for (const u of units) {
      g.fillStyle = "#3b3b3f";
      g.fillRect(u.x, 0, 14, H);
      g.fillStyle = "#111215";
      g.fillRect(u.x + 14, 4, 242, 24);
      g.fillStyle = "#4a4a4e";
      lettering(g, u.x, u.name);
      if (u.shutter) {
        g.fillStyle = "#44464a";
        g.fillRect(u.x + 20, 32, 230, 96);
        g.fillStyle = "rgba(0,0,0,0.35)";
        for (let y = 32; y < H; y += 4) g.fillRect(u.x + 20, y, 230, 1);
      } else {
        g.fillStyle = "#090b10";
        g.fillRect(u.x + 20, 32, 230, 96);
        g.fillStyle = "#2c2d31";
        g.fillRect(u.x + 132, 32, 3, 96);
      }
      const grime = g.createLinearGradient(0, 84, 0, H);
      grime.addColorStop(0, "rgba(0,0,0,0)");
      grime.addColorStop(1, "rgba(0,0,0,0.55)");
      g.fillStyle = grime;
      g.fillRect(u.x + 14, 84, 242, 44);
      if (u.shutter && u.tag) {
        g.save();
        g.translate(u.x + 40 + rand() * 40, 76 + rand() * 20);
        g.rotate((rand() - 0.5) * 0.25);
        g.font = "italic 900 21px ui-sans-serif, Helvetica, Arial, sans-serif";
        g.fillStyle = u.spray;
        g.fillText(u.tag, 0, 0);
        g.restore();
      }
    }
  });

  const signs = canvasTexture(W, H, (g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    for (const u of units) {
      g.fillStyle = u.color;
      lettering(g, u.x, u.name);
      g.fillRect(u.x + 18, 26, 236, 2);
      if (!u.shutter) {
        // The shop's interior lights, seen through the glass.
        g.fillStyle = "rgba(255,226,180,0.55)";
        g.fillRect(u.x + 20, 32, 112, 96);
        g.fillRect(u.x + 135, 32, 115, 96);
      }
    }
  });
  return { map, signs };
}

/** A data center's wall: concrete bands and two floors of server halls, cyan from within. */
function serverHall() {
  const rand = mulberry32(31);
  const bands = [12, 76];
  const map = canvasTexture(256, 128, (g) => {
    g.fillStyle = "#2b2e33";
    g.fillRect(0, 0, 256, 128);
    speckle(g, rand, 256, 128, 1500);
    g.fillStyle = "rgba(0,0,0,0.3)";
    for (let x = 0; x < 256; x += 32) g.fillRect(x, 0, 1, 128);
    for (const y of bands) {
      g.fillStyle = "#0a0d11";
      g.fillRect(0, y, 256, 38);
    }
  });
  const windows = canvasTexture(256, 128, (g) => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, 256, 128);
    for (const y of bands) {
      g.fillStyle = "rgb(70,175,190)";
      g.fillRect(0, y, 256, 38);
      for (let x = 3; x < 256; x += 21) {
        g.fillStyle = "rgb(6,26,30)";
        g.fillRect(x, y + 5, 15, 33);
        for (let k = 0; k < 7; k++) {
          if (rand() < 0.45) continue;
          g.fillStyle = rand() < 0.85 ? "#b8feff" : "#ff6a5a";
          g.fillRect(x + 2 + rand() * 10, y + 8 + k * 4, 2, 1);
        }
      }
    }
  });
  return { map, windows };
}

function terminalScreen(id: number): THREE.Texture {
  return canvasTexture(256, 160, (g) => {
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
}

// Buildings

/** Background towers past the playable edge. Seen only from above, in the ending. */
function farRing(city: City, rand: () => number): Building[] {
  const out: Building[] = [];
  for (let i = -3; i <= city.blocks + 2; i++) {
    for (let j = -3; j <= city.blocks + 2; j++) {
      if (i >= -1 && i <= city.blocks && j >= -1 && j <= city.blocks) continue;
      const c = blockCenter(city, i, j);
      out.push({ ...c, w: 14 + rand() * 5, d: 14 + rand() * 5, h: 8 + rand() * 30, node: null });
    }
  }
  return out;
}

/** Cornice, plus the clutter that makes a roofline: AC units, stair housings, water towers, masts. */
function rooftop(b: Building, rand: () => number, detail: boolean): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [new THREE.BoxGeometry(b.w + 0.4, 0.5, b.d + 0.4).translate(b.x, b.h + 0.25, b.z)];
  if (!detail) return out;
  const top = b.h + 0.5;
  const spot = (w: number, d: number) => ({
    x: b.x + (rand() - 0.5) * Math.max(0, b.w - w - 2),
    z: b.z + (rand() - 0.5) * Math.max(0, b.d - d - 2),
  });
  const units = Math.floor(rand() * 4);
  for (let i = 0; i < units; i++) {
    const w = 1 + rand() * 1.4;
    const h = 0.8 + rand() * 0.6;
    const d = 1 + rand() * 1.2;
    const p = spot(w, d);
    out.push(new THREE.BoxGeometry(w, h, d).translate(p.x, top + h / 2, p.z));
  }
  if (rand() < 0.35) {
    const p = spot(3, 3);
    out.push(new THREE.BoxGeometry(2.6, 2.6, 3).translate(p.x, top + 1.3, p.z));
  }
  if (b.node === null && b.w >= 7 && b.d >= 7 && rand() < 0.3) {
    const p = spot(3, 3);
    for (const [lx, lz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
      out.push(new THREE.CylinderGeometry(0.07, 0.07, 2.2, 5).translate(p.x + lx, top + 1.1, p.z + lz));
    }
    out.push(new THREE.CylinderGeometry(1.35, 1.35, 2.6, 14).translate(p.x, top + 3.5, p.z));
    out.push(new THREE.ConeGeometry(1.5, 0.9, 14).translate(p.x, top + 5.25, p.z));
  }
  if (b.h > 26 && rand() < 0.4) {
    const mast = 5 + rand() * 7;
    const p = spot(1, 1);
    out.push(new THREE.CylinderGeometry(0.05, 0.08, mast, 5).translate(p.x, top + mast / 2, p.z));
    out.push(new THREE.BoxGeometry(1.6, 0.05, 0.05).translate(p.x, top + mast * 0.8, p.z));
  }
  return out;
}

const TINTS = [
  [1, 0.86, 0.78],
  [0.9, 0.9, 0.9],
  [0.82, 0.88, 0.98],
  [0.64, 0.64, 0.68],
  [1.08, 1.04, 0.96],
];

function buildings(city: City, rand: () => number): THREE.Object3D[] {
  const styles = (["flats", "office", "tower"] as const).map((s, i) => facade(s, 21 + i));
  const walls: THREE.BufferGeometry[][] = [[], [], []];
  const shops: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const near = city.buildings.filter((b) => b.node === null).map((b) => ({ b, inCity: true }));
  const far = farRing(city, rand).map((b) => ({ b, inCity: false }));
  for (const { b, inCity } of [...near, ...far]) {
    const style = b.h > 30 ? 1 + Math.floor(rand() * 2) : Math.floor(rand() * 3);
    const delay = rand();
    const tint = TINTS[Math.floor(rand() * TINTS.length)].map((v) => v * (0.85 + rand() * 0.3));
    const offset: [number, number] = [Math.floor(rand() * 8) / 8, Math.floor(rand() * 8) / 8];
    const wall = tiledBox(b.w, b.h, b.d, FACADE, offset).translate(b.x, b.h / 2, b.z);
    walls[style].push(fill(fill(wall, "aPower", b.x, b.z, delay), "color", ...tint));
    if (inCity) {
      const shop = tiledBox(b.w + 0.3, 4, b.d + 0.3, SHOP, [rand(), 0], [0.005, 0.5]).translate(b.x, 2, b.z);
      shops.push(fill(shop, "aPower", b.x, b.z, delay));
    }
    roofs.push(...rooftop(b, rand, inCity));
  }
  for (const b of city.buildings) if (b.node !== null) roofs.push(...rooftop(b, rand, true));

  const meshes: THREE.Object3D[] = walls.map(
    (parts, i) =>
      new THREE.Mesh(
        merge(parts),
        powered(
          new THREE.MeshStandardMaterial({
            map: styles[i].map,
            emissiveMap: styles[i].windows,
            emissive: 0xffffff,
            emissiveIntensity: 1.2,
            roughnessMap: styles[i].roughness,
            roughness: 1,
            metalness: 0.1,
            vertexColors: true,
          }),
          "#include <emissivemap_fragment>",
          "totalEmissiveRadiance *= vPower;",
        ),
      ),
  );
  const shop = storefronts();
  meshes.push(
    new THREE.Mesh(
      merge(shops),
      powered(
        new THREE.MeshStandardMaterial({
          map: shop.map,
          emissiveMap: shop.signs,
          emissive: 0xffffff,
          emissiveIntensity: 2.4,
          roughness: 0.62,
          metalness: 0.25,
        }),
        "#include <emissivemap_fragment>",
        "totalEmissiveRadiance *= vPower;",
      ),
    ),
    new THREE.Mesh(merge(roofs), new THREE.MeshStandardMaterial({ color: 0x1d1e23, roughness: 0.85, metalness: 0.2 })),
  );
  return meshes;
}

// Streets

function streets(city: City, rand: () => number): THREE.Object3D[] {
  const size = city.half * 2 + 600;
  const asphalt = canvasTexture(512, 512, (g) => {
    g.fillStyle = "#222226";
    g.fillRect(0, 0, 512, 512);
    speckle(g, rand, 512, 512, 14000);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = rand() < 0.5 ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.025)";
      g.fillRect(rand() * 512, rand() * 512, 40 + rand() * 120, 30 + rand() * 90);
    }
    g.strokeStyle = "rgba(0,0,0,0.55)";
    for (let i = 0; i < 12; i++) {
      g.lineWidth = 0.6 + rand() * 1.4;
      g.beginPath();
      let x = rand() * 512;
      let y = rand() * 512;
      g.moveTo(x, y);
      for (let k = 0; k < 8; k++) g.lineTo((x += (rand() - 0.5) * 40), (y += (rand() - 0.5) * 40));
      g.stroke();
    }
  });
  asphalt.repeat.set(size / 8, size / 8);
  // Rain left puddles: smooth patches that catch the flashlight and the node glow.
  const puddles = canvasTexture(
    512,
    512,
    (g) => {
      g.fillStyle = "rgb(235,235,235)";
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 16; i++) {
        const cx = rand() * 512;
        const cy = rand() * 512;
        for (let k = 0; k < 3; k++) {
          const x = cx + (rand() - 0.5) * 60;
          const y = cy + (rand() - 0.5) * 40;
          const r = 18 + rand() * 45;
          for (const dx of [-512, 0, 512]) {
            for (const dy of [-512, 0, 512]) {
              const grd = g.createRadialGradient(x + dx, y + dy, r * 0.5, x + dx, y + dy, r);
              grd.addColorStop(0, "rgba(115,115,115,1)");
              grd.addColorStop(1, "rgba(115,115,115,0)");
              g.fillStyle = grd;
              g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
            }
          }
        }
      }
    },
    false,
  );
  puddles.repeat.set(size / 56, size / 56);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: asphalt, roughnessMap: puddles, roughness: 1 }),
  );

  const paving = canvasTexture(128, 128, (g) => {
    g.fillStyle = "#46474c";
    g.fillRect(0, 0, 128, 128);
    speckle(g, rand, 128, 128, 1200);
    g.fillStyle = "#313236";
    for (const k of [0, 64]) {
      g.fillRect(k, 0, 2, 128);
      g.fillRect(0, k, 128, 2);
    }
  });
  const slabs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < city.blocks; i++) {
    for (let j = 0; j < city.blocks; j++) {
      const c = blockCenter(city, i, j);
      const slab = new THREE.BoxGeometry(city.blockSize, 0.12, city.blockSize);
      const uv = slab.attributes.uv as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 12, uv.getY(k) * 12);
      slabs.push(slab.translate(c.x, 0.06, c.z));
    }
  }
  const sidewalks = new THREE.Mesh(merge(slabs), new THREE.MeshStandardMaterial({ map: paving, roughness: 0.9 }));

  // Road paint: crosswalks at every junction, faded dashes down each block.
  const white = new THREE.Color(0x8d8a80);
  const yellow = new THREE.Color(0x8a7838);
  const marks: THREE.BufferGeometry[] = [];
  const mark = (x: number, z: number, sx: number, sz: number, c: THREE.Color) =>
    marks.push(fill(new THREE.PlaneGeometry(sx, sz).rotateX(-Math.PI / 2).translate(x, 0.02, z), "color", c.r, c.g, c.b));
  const arms: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i <= city.blocks; i++) {
    for (let j = 0; j <= city.blocks; j++) {
      const c = intersection(city, i, j);
      for (const [dx, dz] of arms) {
        const ni = i + dx;
        const nj = j + dz;
        if (ni < 0 || nj < 0 || ni > city.blocks || nj > city.blocks) continue;
        const along = city.streetWidth / 2 + 1.6;
        for (let s = 0; s < 6; s++) {
          const across = -3.75 + s * 1.5;
          if (dx) mark(c.x + dx * along, c.z + across, 2.6, 0.6, white);
          else mark(c.x + across, c.z + dz * along, 0.6, 2.6, white);
        }
        // Lane dashes on the block-long run to the next junction.
        if (dx > 0 || dz > 0) {
          for (let k = 0; k < 5; k++) {
            const t = city.streetWidth / 2 + 5.3 + k * 3;
            if (dx) mark(c.x + t, c.z, 1.6, 0.18, yellow);
            else mark(c.x, c.z + t, 0.18, 1.6, yellow);
          }
        }
      }
    }
  }
  const paint = new THREE.Mesh(
    merge(marks),
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  return [ground, sidewalks, paint];
}

/** A box whose top face is shorter than its base, so the glass slopes front and back. */
function cabin(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const position = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) > 0) position.setZ(i, position.getZ(i) * 0.72);
  }
  g.computeVertexNormals();
  return g;
}

const PAINTS = [0x5b1d1d, 0x23293a, 0x6e7177, 0x17181b, 0x8b8069, 0x2c4536, 0xa9a9a2, 0x3d2f4a];

function cars(city: City): THREE.Mesh {
  const tone = (g: THREE.BufferGeometry, hex: number | THREE.Color) => {
    const c = new THREE.Color(hex);
    return fill(g, "color", c.r, c.g, c.b);
  };
  const { length: L, width: W } = CAR;
  const parts = city.cars.map((car) => {
    const paint = PAINTS[Math.floor(car.paint * PAINTS.length)];
    const pieces = [
      tone(new THREE.BoxGeometry(W, 0.62, L).translate(0, 0.62, 0), paint),
      tone(cabin(W - 0.22, 0.55, L * 0.5).translate(0, 1.2, -0.2), 0x0a0d13),
      tone(new THREE.BoxGeometry(W - 0.3, 0.06, L * 0.36).translate(0, 1.5, -0.2), paint),
    ];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10).rotateZ(Math.PI / 2);
        pieces.push(tone(wheel.translate(sx * (W / 2 - 0.12), 0.34, sz * L * 0.32), 0x0b0b0b));
      }
      pieces.push(tone(new THREE.BoxGeometry(0.36, 0.12, 0.04).translate(sx * 0.6, 0.74, L / 2), 0x5c5a50));
      pieces.push(tone(new THREE.BoxGeometry(0.36, 0.12, 0.04).translate(sx * 0.6, 0.74, -L / 2), 0x4a0d0d));
    }
    return merge(pieces).rotateY(car.yaw).translate(car.x, 0, car.z);
  });
  return new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.48 }));
}

/** Street lamps at every block corner. Dead until the wave reaches them. */
function lamps(city: City, rand: () => number): THREE.Object3D[] {
  const pole = new THREE.CylinderGeometry(0.08, 0.12, 7, 6).translate(0, 3.5, 0);
  const arm = new THREE.BoxGeometry(1.2, 0.08, 0.08).translate(0.6, 6.95, 0);
  const head = new THREE.BoxGeometry(0.7, 0.16, 0.3).translate(1.05, 6.85, 0);
  const pool = new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2);
  const poles: THREE.BufferGeometry[] = [];
  const heads: THREE.BufferGeometry[] = [];
  const pools: THREE.BufferGeometry[] = [];
  const off = city.blockSize / 2 - 0.8;
  for (let i = 0; i < city.blocks; i++) {
    for (let j = 0; j < city.blocks; j++) {
      const c = blockCenter(city, i, j);
      for (const kx of [-1, 1]) {
        for (const kz of [-1, 1]) {
          const x = c.x + kx * off;
          const z = c.z + kz * off;
          const angle = Math.atan2(-kz, kx);
          const delay = rand() * 0.4;
          poles.push(pole.clone().translate(x, 0, z), arm.clone().rotateY(angle).translate(x, 0, z));
          heads.push(fill(head.clone().rotateY(angle).translate(x, 0, z), "aPower", x, z, delay));
          pools.push(fill(pool.clone().translate(x + kx * 0.75, 0.14, z + kz * 0.75), "aPower", x, z, delay));
        }
      }
    }
  }
  return [
    new THREE.Mesh(merge(poles), new THREE.MeshStandardMaterial({ color: 0x17181d, metalness: 0.3, roughness: 0.7 })),
    new THREE.Mesh(
      merge(heads),
      powered(
        new THREE.MeshBasicMaterial({ color: LAMP_LIGHT.clone().multiplyScalar(4) }),
        "#include <color_fragment>",
        "diffuseColor.rgb *= mix(0.002, 1.0, vPower);",
      ),
    ),
    new THREE.Mesh(
      merge(pools),
      powered(
        new THREE.MeshBasicMaterial({
          map: glowTexture(),
          color: LAMP_LIGHT.clone().multiplyScalar(0.55),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
        "#include <color_fragment>",
        "diffuseColor.rgb *= vPower;",
      ),
    ),
  ];
}

// Nodes

function makeNode(city: City, site: NodeSite, hall: ReturnType<typeof serverHall>, scene: THREE.Scene) {
  const b = city.buildings[site.building];
  const material = new THREE.MeshStandardMaterial({
    map: hall.map,
    emissiveMap: hall.windows,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    roughness: 0.8,
    // Visible from across the city, like lit windows on a clear night.
    fog: false,
  });
  const building = new THREE.Mesh(tiledBox(b.w, b.h, b.d, HALL).translate(b.x, b.h / 2, b.z), material);

  const beamMaterial = shaftMaterial(0x7df9ff, 0);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 4, 300, 20, 1, true), beamMaterial);
  beam.position.set(b.x, b.h + 150, b.z);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 8, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.25, 0.2), fog: false }),
  );
  beacon.position.set(b.x - b.w / 2 + 1, b.h + 0.8, b.z - b.d / 2 + 1);

  const glow = new THREE.PointLight(0x7df9ff, 70, 55, 2);
  glow.position.set(site.x + site.facing.x * 4, 6, site.z + site.facing.z * 4);

  const terminal = new THREE.Group();
  terminal.position.set(site.x, 0, site.z);
  terminal.rotation.y = Math.atan2(site.facing.x, site.facing.z);
  const rack = new THREE.Mesh(
    new THREE.BoxGeometry(TERMINAL.w, TERMINAL.h, TERMINAL.d),
    new THREE.MeshStandardMaterial({ color: 0x1a1d23, metalness: 0.7, roughness: 0.35 }),
  );
  rack.position.y = TERMINAL.h / 2;
  const screenMaterial = new THREE.MeshBasicMaterial({ map: terminalScreen(site.id) });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.56), screenMaterial);
  screen.position.set(0, 1.42, TERMINAL.d / 2 + 0.006);
  // A lit strip along the top edge, so the terminal reads as the thing to touch.
  const stripMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.4, 2.6) });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(TERMINAL.w + 0.02, 0.04, TERMINAL.d + 0.02), stripMaterial);
  strip.position.y = TERMINAL.h - 0.02;
  const ledMaterial = new THREE.MeshBasicMaterial({ color: 0x4dff88 });
  const ledGeometry = new THREE.BoxGeometry(0.06, 0.06, 0.02);
  const leds = Array.from({ length: 6 }, (_, i) => {
    const led = new THREE.Mesh(ledGeometry, ledMaterial);
    led.position.set(-0.35 + i * 0.14, 0.9, TERMINAL.d / 2 + 0.01);
    return led;
  });
  terminal.add(rack, screen, strip, ...leds);

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
      material.emissiveIntensity = v;
      beamMaterial.uniforms.uOpacity.value = 0.22 * v;
      glow.intensity = 70 * v;
      screenMaterial.color.setScalar(v > 0.3 ? 1 : 0.02);
      stripMaterial.color.setRGB(0.6 * v, 2.4 * v, 2.6 * v);
      ledMaterial.color.setHex(v > 0.3 ? 0x4dff88 : 0x200000);
      beacon.visible = n.lit && Math.sin(time * 3 + site.id) > 0.6;
      const dark = level === 0;
      if (dark !== material.fog) {
        material.fog = dark;
        material.needsUpdate = true;
      }
      beam.visible = !dark;
    },
  };
}

export function createWorld(scene: THREE.Scene, city: City) {
  const rand = mulberry32(1234);
  scene.add(...streets(city, rand), ...buildings(city, rand), cars(city), ...lamps(city, rand));
  const hall = serverHall();
  const nodes = city.nodes.map((site) => makeNode(city, site, hall, scene));
  return {
    update(game: Game, dt: number, time: number) {
      power.uTime.value = time;
      game.nodes.forEach((n, i) => nodes[i].update(n, dt, time));
    },
    /** The power wave's front, in meters from `origin`. Negative means the city is dark. */
    setPower(origin: Vec2, radius: number) {
      power.uPowerOrigin.value.set(origin.x, origin.z);
      power.uPowerRadius.value = radius;
    },
  };
}
