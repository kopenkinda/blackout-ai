// The four hunters, each a nod to the model it is named after. The Claude
// pair (Opus, Fable) is rounded with warm clay light. The Codex pair (Sol,
// Astra) is angular with gold and starlight.

import * as THREE from "three";
import { mulberry32 } from "./city.ts";
import type { Game, Hunter, HunterProfile } from "./game.ts";
import { canvasTexture, glowTexture, shaftMaterial } from "./world.ts";

const LOOKS: Record<string, { color: number; w: number; h: number; d: number; cables: number; bob: number }> = {
  OPUS: { color: 0xff8a3d, w: 0.84, h: 2.3, d: 0.84, cables: 9, bob: 1.2 },
  FABLE: { color: 0xffb089, w: 0.4, h: 2.7, d: 0.4, cables: 5, bob: 3.2 },
  SOL: { color: 0xffe08a, w: 0.5, h: 2.6, d: 0.32, cables: 5, bob: 2 },
  ASTRA: { color: 0x9fd0ff, w: 0.34, h: 2.8, d: 0.22, cables: 5, bob: 2 },
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => t * t * (3 - 2 * t);

export function shortestTurn(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

export function createHunter(scene: THREE.Scene, profile: HunterProfile, index: number) {
  const look = LOOKS[profile.name];
  const rand = mulberry32(11 + index);
  const color = new THREE.Color(look.color);
  const rounded = profile.maker === "claude";
  const sol = profile.name === "SOL";
  const base = 0.9;
  const top = base + look.h;
  const eyeY = top + 0.32;
  const front = rounded ? look.w / 2 : 0.25;

  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial(
    rounded
      ? { color: 0x0c0a09, metalness: 0.55, roughness: 0.45 }
      : { color: 0x07080c, metalness: 0.85, roughness: 0.32 },
  );
  // Everything that glows shares one material, so it all dims and pulses together.
  const lit = new THREE.MeshBasicMaterial({ color });
  const body = new THREE.Mesh(
    rounded
      ? new THREE.CapsuleGeometry(look.w / 2, look.h - look.w, 4, 16)
      : new THREE.BoxGeometry(look.w, look.h, look.d),
    shell,
  );
  body.position.y = base + look.h / 2;
  const head = new THREE.Mesh(
    rounded ? new THREE.SphereGeometry(look.w * 0.5, 18, 12) : new THREE.BoxGeometry(look.w * 1.3, 0.46, 0.5),
    shell,
  );
  head.position.y = eyeY;
  // A seam of light down the front of the body.
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.025, look.h * 0.62, 0.01), lit);
  seam.position.set(0, base + look.h * 0.42, (rounded ? look.w / 2 : look.d / 2) + 0.006);
  // The glow ignores fog, so the light shows as a point from far away.
  const glowMaterial = new THREE.SpriteMaterial({
    map: glowTexture(),
    color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const glow = new THREE.Sprite(glowMaterial);
  glow.position.set(0, eyeY, front + 0.05);
  glow.scale.set(sol ? 2 : 0.9, sol ? 1.6 : 0.75, 1);
  const light = new THREE.PointLight(color, 12, sol ? 36 : 16, 2);
  light.position.set(0, eyeY, front + 0.3);
  const tag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.56, 0.14),
    new THREE.MeshBasicMaterial({
      map: canvasTexture(256, 64, (g) => {
        g.font = "bold 44px ui-monospace, Menlo, monospace";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.globalAlpha = 0.85;
        g.fillStyle = `#${color.getHexString()}`;
        g.fillText(profile.name, 128, 34);
      }),
      transparent: true,
    }),
  );
  tag.position.set(0.12, base + look.h * 0.7, (rounded ? look.w / 2 : look.d / 2) + 0.012);
  tag.scale.setScalar(0.8);
  group.add(body, head, seam, glow, light, tag);

  // Eyes. Fable blinks three dots in turn, the others hold one steady light.
  const dots: THREE.Mesh[] = [];
  if (profile.name === "FABLE") {
    for (const k of [-1, 0, 1]) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), lit);
      dot.position.set(k * 0.11, eyeY, front + 0.02);
      dots.push(dot);
    }
    group.add(...dots);
  } else {
    const eye = new THREE.Mesh(
      rounded ? new THREE.SphereGeometry(0.1, 12, 12) : new THREE.BoxGeometry(0.36, 0.07, 0.02),
      lit,
    );
    eye.position.set(0, eyeY, front + 0.02);
    group.add(eye);
  }

  // Sol carries a halo and throws a searchlight ahead of it.
  let cone: THREE.ShaderMaterial | undefined;
  if (sol) {
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.025, 8, 40), lit);
    halo.rotation.x = Math.PI / 2;
    halo.position.y = top + 0.9;
    cone = shaftMaterial(color, 1);
    // Apex at the eye, opening forward and down.
    const beam = new THREE.Mesh(
      new THREE.ConeGeometry(1.9, 11, 24, 1, true).translate(0, -5.5, 0).rotateX(-(Math.PI / 2 - 0.42)),
      cone,
    );
    beam.position.set(0, eyeY, front + 0.05);
    group.add(halo, beam);
  }
  let orbit: THREE.Group | undefined;
  if (profile.name === "ASTRA") {
    orbit = new THREE.Group();
    orbit.position.y = eyeY;
    for (let i = 0; i < 6; i++) {
      const star = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), lit);
      star.position.set((rand() - 0.5) * 1.3, (rand() - 0.5) * 0.9, (rand() - 0.5) * 1.3);
      orbit.add(star);
    }
    group.add(orbit);
  }
  // Loose cables hang from the base, swing as it moves, and never reach the ground.
  const cables = Array.from({ length: look.cables }, () => {
    const length = 0.5 + rand() * 0.7;
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, length, 4).translate(0, -length / 2, 0), shell);
    cable.position.set((rand() - 0.5) * look.w, base, (rand() - 0.5) * look.d);
    group.add(cable);
    return { cable, phase: rand() * 6, tilt: (rand() - 0.5) * 0.3 };
  });
  scene.add(group);

  let yaw = 0;
  let level = 1;
  let speed = 0;
  const last = { x: NaN, z: NaN };
  return {
    update(h: Hunter, game: Game, dt: number, time: number, winT: number) {
      const p = game.player;
      // Powers down in the ending, sinking and tilting as its light dies.
      level = winT >= 0 ? Math.max(0, level - dt * 0.8) : Math.min(1, level + dt);
      const sink = winT >= 0 ? ease(clamp01(winT / 2.5)) : 0;

      const dx = h.x - last.x;
      const dz = h.z - last.z;
      const moved = Number.isNaN(last.x) ? 0 : Math.hypot(dx, dz);
      speed += (moved / Math.max(dt, 1e-4) - speed) * Math.min(1, dt * 5);
      if (game.status === "caught" && game.caughtBy === index) {
        yaw += shortestTurn(yaw, Math.atan2(p.x - h.x, p.z - h.z)) * Math.min(1, dt * 10);
      } else if (moved > 1e-3) {
        yaw += shortestTurn(yaw, Math.atan2(dx, dz)) * Math.min(1, dt * 8);
      }
      last.x = h.x;
      last.z = h.z;

      // It never holds quite still up close.
      const near = Math.hypot(p.x - h.x, p.z - h.z);
      const glitch = winT < 0 && near < 18 && Math.random() < 0.12 ? 0.18 : 0;
      const jitter = () => (Math.random() - 0.5) * glitch;
      group.position.set(
        h.x + jitter(),
        Math.sin(time * look.bob + index) * 0.08 - sink * 0.8 + jitter(),
        h.z + jitter(),
      );
      group.rotation.set(0, yaw, sink * 0.35 * (index % 2 ? 1 : -1));
      const trail = Math.min(0.5, speed * 0.08);
      for (const c of cables) {
        c.cable.rotation.set(trail + Math.sin(time * 2.3 + c.phase) * 0.12, 0, c.tilt + Math.sin(time * 1.7 + c.phase) * 0.08);
      }

      const hunting = h.state === "hunt";
      const pulse = hunting ? 1 + 0.35 * Math.sin(time * 14) : 1;
      const k = (hunting ? 2.4 : 1.4) * pulse * level;
      light.intensity = (hunting ? 34 : 12) * (sol ? 1.8 : 1) * pulse * level;
      lit.color.copy(color).multiplyScalar(k);
      glowMaterial.opacity = Math.min(1, 0.35 * k);
      if (cone) cone.uniforms.uOpacity.value = (hunting ? 0.16 : 0.09) * level;
      dots.forEach((dot, i) => {
        dot.visible = hunting || Math.floor(time * 4) % 3 === i;
      });
      if (orbit) orbit.rotation.y = time * 0.8;
    },
  };
}
