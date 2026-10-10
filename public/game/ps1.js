// PS1-style presentation: render at a low internal resolution, snap vertices to that pixel
// grid (the PS1's wobbly geometry), quantize to 15-bit colour with ordered dithering, and
// upscale with nearest-neighbour filtering. Toggle with P.
import * as THREE from "three";

export const PS1_HEIGHT = 240;

const blitVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const blitFrag = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 resolution;
varying vec2 vUv;
float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return float(m[i]) / 16.0 - 0.5;
}
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c = pow(max(c, 0.0), vec3(1.0 / 2.2)); // to display gamma, so quantization steps look even
  vec2 px = floor(vUv * resolution);
  c += bayer4(px) / 31.0;              // ordered dither before quantizing
  c = floor(c * 31.0 + 0.5) / 31.0;    // 5 bits per channel
  gl_FragColor = vec4(c, 1.0);
}`;

export class PS1Pass {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this.target = new THREE.WebGLRenderTarget(320, PS1_HEIGHT, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType,
    });
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.target.texture }, resolution: { value: new THREE.Vector2(320, PS1_HEIGHT) } },
      vertexShader: blitVert, fragmentShader: blitFrag, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.snap = { value: new THREE.Vector2(160, PS1_HEIGHT / 2) };
  }

  setSize(width, height) {
    const w = Math.round((PS1_HEIGHT * width) / height);
    this.target.setSize(w, PS1_HEIGHT);
    this.material.uniforms.resolution.value.set(w, PS1_HEIGHT);
    this.snap.value.set(w / 2, PS1_HEIGHT / 2);
  }

  /** Patch a material so its vertices snap to the low-res pixel grid. Idempotent. */
  wobble(material) {
    if (material.userData.ps1) return;
    material.userData.ps1 = true;
    const snap = this.snap;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, r) => {
      prev?.call(material, shader, r);
      shader.uniforms.ps1Snap = snap;
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", "uniform vec2 ps1Snap;\nvoid main() {")
        .replace("#include <project_vertex>", `#include <project_vertex>
  if (ps1Snap.x > 0.0) {
    vec2 ndc = gl_Position.xy / gl_Position.w;
    gl_Position.xy = floor(ndc * ps1Snap + 0.5) / ps1Snap * gl_Position.w;
  }`);
    };
    material.customProgramCacheKey = () => "ps1";
    material.needsUpdate = true;
  }

  /** Apply vertex wobble to every mesh under `root`. */
  wobbleAll(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.wobble(m);
    });
  }

  render(scene, camera) {
    // Snapping off when the effect is off (the uniform is shared by all patched materials).
    this.snap.value.x = this.enabled ? this.target.width / 2 : 0;
    if (!this.enabled) { this.renderer.setRenderTarget(null); this.renderer.render(scene, camera); return; }
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}
