// Rendering: the camera, sky, moon, flashlight, dust, post-processing, and
// the ending where the power comes back. The city comes from world.ts and
// the hunters from hunters.ts. Reads game state every frame, never changes it.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { mulberry32, type City } from "./city.ts";
import { PLAYER, PROFILES, type Game } from "./game.ts";
import { createHunter, shortestTurn } from "./hunters.ts";
import { canvasTexture, createWorld, glowTexture } from "./world.ts";

export type SceneView = { render(game: Game, dt: number): void };

/** Seconds the ending runs before the interface takes over. */
export const WIN_SEQUENCE = 9.5;

/** How the night looks, and how it looks once the power is back. */
const NIGHT = {
  top: new THREE.Color(0x020309),
  horizon: new THREE.Color(0x0b0f1e),
  hemi: new THREE.Color(0x1d2542),
  fog: 0.014,
};
const POWERED = {
  top: new THREE.Color(0x070a17),
  horizon: new THREE.Color(0x3b2519),
  hemi: new THREE.Color(0x4d4250),
  fog: 0.005,
};
/** Low in the north, so it hangs at the end of the north-south streets. */
const MOON = new THREE.Vector3(0.14, 0.34, -0.93).normalize();
const FLASHLIGHT = 220;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => t * t * (3 - 2 * t);

/** Film grain, plus interference that tears the image as a hunter gets close. */
const FILM = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uDanger: { value: 0 },
    uGlitch: { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uDanger;
    uniform float uGlitch;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      float row = floor(uv.y * 140.0);
      float tear = step(1.0 - 0.08 * uDanger * uDanger * uGlitch, hash(vec2(row, floor(uTime * 24.0))));
      uv.x += tear * (hash(vec2(uTime, row)) - 0.5) * 0.05;
      vec2 split = (uv - 0.5) * (0.0015 + 0.009 * uDanger);
      vec3 c = vec3(texture2D(tDiffuse, uv + split).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - split).b);
      c += (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) * (0.05 + 0.04 * uDanger);
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export function createScene(mount: HTMLElement, city: City): SceneView {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(NIGHT.horizon.getHex(), NIGHT.fog);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 900);
  camera.rotation.order = "YXZ";
  scene.add(camera);

  const hemi = new THREE.HemisphereLight(NIGHT.hemi, 0x050505, 0.6);
  const moonlight = new THREE.DirectionalLight(0x8ea6dc, 0.7);
  moonlight.position.copy(MOON).multiplyScalar(100);
  scene.add(hemi, moonlight);

  const flashlight = new THREE.SpotLight(0xfff1d6, FLASHLIGHT, 60, 0.42, 0.5, 1.6);
  flashlight.position.set(0.25, -0.2, 0);
  flashlight.target.position.set(0, -0.6, -10);
  camera.add(flashlight, flashlight.target);

  const heavens = sky();
  const night = stars();
  const moon = moonSprites();
  const motes = dust();
  scene.add(heavens.mesh, night, moon.disc, moon.halo, motes.points);
  const world = createWorld(scene, city);
  const hunters = PROFILES.map((profile, i) => createHunter(scene, profile, i));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 1);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const film = new ShaderPass(FILM);
  composer.addPass(film);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = mount;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    motes.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
  };
  new ResizeObserver(resize).observe(mount);
  resize();

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  film.uniforms.uGlitch.value = reducedMotion ? 0 : 1;
  let time = 0;
  let bob = 0;
  let yaw = 0;
  let pitch = 0;
  /** Seconds into the ending, or -1 while playing. */
  let winT = -1;
  const winOrigin = { x: 0, z: 0 };

  /** The power comes back in a wave from where you stand. The sky warms with it. */
  const powerUp = (t: number) => {
    world.setPower(winOrigin, (t - 1.6) * 46);
    const lights = ease(clamp01((t - 2) / 5));
    heavens.uniforms.uTop.value.lerpColors(NIGHT.top, POWERED.top, lights);
    heavens.uniforms.uHorizon.value.lerpColors(NIGHT.horizon, POWERED.horizon, lights);
    fog.color.copy(heavens.uniforms.uHorizon.value);
    fog.density = NIGHT.fog + (POWERED.fog - NIGHT.fog) * lights;
    hemi.intensity = 0.6 + 1.1 * lights;
    hemi.color.lerpColors(NIGHT.hemi, POWERED.hemi, lights);
    night.material.opacity = 0.6 - 0.4 * lights;
    bloom.strength = 0.7 + 0.35 * lights;
  };

  return {
    render(game, dt) {
      time += dt;
      const p = game.player;
      if (game.status === "won") {
        if (winT < 0) {
          winT = 0;
          winOrigin.x = p.x;
          winOrigin.z = p.z;
        } else {
          winT += dt;
        }
        powerUp(winT);
      } else if (winT >= 0) {
        winT = -1;
        powerUp(0);
      }

      if (p.moving && game.status === "playing" && !reducedMotion) {
        bob += dt * (p.sprinting ? 11 : 7.5);
      }
      let height = PLAYER.eye;
      if (game.status === "caught" && game.caughtBy !== null) {
        // Turn to face the thing that found you.
        const h = game.hunters[game.caughtBy];
        yaw += shortestTurn(yaw, Math.atan2(-(h.x - p.x), -(h.z - p.z))) * Math.min(1, dt * 6);
        pitch += (0.3 - pitch) * Math.min(1, dt * 6);
      } else if (winT >= 0) {
        // Rise above the streets and watch the city come back.
        const rise = ease(clamp01((winT - 1) / 7));
        yaw = p.yaw + winT * 0.1;
        pitch = p.pitch * (1 - rise) - 0.42 * rise;
        height += rise * 55;
      } else {
        yaw = p.yaw;
        pitch = p.pitch;
      }
      camera.position.set(p.x, height + Math.sin(bob) * 0.035, p.z);
      camera.rotation.set(pitch, yaw, 0);

      const beam = 1 - clamp01((winT - 2) / 2);
      flashlight.visible = game.flashlight;
      flashlight.intensity = FLASHLIGHT * beam * (0.95 + 0.05 * Math.sin(time * 37) * Math.sin(time * 11));
      heavens.mesh.position.copy(camera.position);
      night.position.copy(camera.position);
      moon.disc.position.copy(camera.position).addScaledVector(MOON, 600);
      moon.halo.position.copy(moon.disc.position);
      motes.uniforms.uCam.value.copy(camera.position);
      motes.uniforms.uTime.value = time;
      motes.uniforms.uLight.value = game.flashlight ? beam : 0;

      const danger = game.status === "playing" ? game.danger : game.status === "caught" ? 1 : 0;
      film.uniforms.uDanger.value += (danger - film.uniforms.uDanger.value) * Math.min(1, dt * 4);
      if (!reducedMotion) film.uniforms.uTime.value = time;

      world.update(game, dt, time);
      game.hunters.forEach((h, i) => hunters[i].update(h, game, dt, time, winT));
      composer.render(dt);
    },
  };
}

/** A gradient dome that follows the camera, with haze around the moon. */
function sky() {
  const uniforms = {
    uTop: { value: NIGHT.top.clone() },
    uHorizon: { value: NIGHT.horizon.clone() },
    uMoon: { value: MOON },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(700, 32, 16),
    new THREE.ShaderMaterial({
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uMoon;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = mix(uHorizon, uTop, pow(clamp(d.y, 0.0, 1.0), 0.5));
          c += vec3(0.02, 0.026, 0.04) * pow(max(dot(d, uMoon), 0.0), 16.0);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  mesh.renderOrder = -1;
  return { mesh, uniforms };
}

function stars(): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
  const rand = mulberry32(99);
  const count = 900;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(0.12 + rand() * 0.88);
    const r = 600;
    positions.set([r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xaab8ff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      fog: false,
    }),
  );
}

function moonSprites() {
  const face = canvasTexture(128, 128, (g) => {
    const edge = g.createRadialGradient(64, 64, 52, 64, 64, 60);
    edge.addColorStop(0, "rgba(236,240,250,1)");
    edge.addColorStop(1, "rgba(236,240,250,0)");
    g.fillStyle = edge;
    g.fillRect(0, 0, 128, 128);
    const rand = mulberry32(5);
    for (let i = 0; i < 9; i++) {
      g.fillStyle = `rgba(120,130,155,${(0.15 + rand() * 0.2).toFixed(2)})`;
      g.beginPath();
      g.arc(34 + rand() * 60, 34 + rand() * 60, 4 + rand() * 12, 0, Math.PI * 2);
      g.fill();
    }
  });
  const disc = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: face, color: new THREE.Color(0.95, 1, 1.1), fog: false, depthWrite: false }),
  );
  disc.scale.setScalar(26);
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color(0.07, 0.09, 0.15),
      blending: THREE.AdditiveBlending,
      fog: false,
      depthWrite: false,
    }),
  );
  halo.scale.setScalar(110);
  return { disc, halo };
}

/** Dust drifting around the camera, visible only where the flashlight catches it. */
function dust() {
  const rand = mulberry32(17);
  const box = 12;
  const positions = new Float32Array(700 * 3).map(() => rand() * box);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const uniforms = {
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uLight: { value: 1 },
    uScale: { value: 600 },
  };
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform vec3 uCam;
        uniform float uTime;
        uniform float uScale;
        varying float vLight;
        void main() {
          vec3 drift = vec3(sin(uTime * 0.21 + position.y), sin(uTime * 0.37 + position.x) * 0.4 - uTime * 0.12, cos(uTime * 0.17 + position.z)) * 0.6;
          vec3 p = mod(position + drift - uCam, ${box}.0) - ${box / 2}.0 + uCam;
          vec4 view = viewMatrix * vec4(p, 1.0);
          float dist = -view.z;
          float cone = smoothstep(0.88, 0.975, dot(normalize(view.xyz), normalize(vec3(0.0, -0.05, -1.0))));
          vLight = cone * smoothstep(0.5, 1.2, dist) * (1.0 - smoothstep(3.0, 6.0, dist));
          gl_Position = projectionMatrix * view;
          gl_PointSize = max(1.0, uScale * 0.008 / dist);
        }`,
      fragmentShader: `
        uniform float uLight;
        varying float vLight;
        void main() {
          float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5)) * vLight * uLight;
          gl_FragColor = vec4(vec3(1.0, 0.94, 0.82) * a * 0.55, 1.0);
        }`,
    }),
  );
  points.frustumCulled = false;
  return { points, uniforms };
}
