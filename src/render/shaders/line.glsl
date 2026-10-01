// Thick glowing line segments as instanced quads. Width and falloff are computed
// in the fragment shader from the distance to the segment, so nothing depends on
// gl.lineWidth and the edge stays sharp at any device pixel ratio.
#ifdef VERTEX
layout(location = 0) in vec2 a_corner;  // x: -1 start cap, 1 end cap; y: side
layout(location = 1) in vec4 i_seg;     // x0 y0 x1 y1 in map units
layout(location = 2) in vec3 i_style;   // width, glow radius, dash period
layout(location = 3) in vec4 i_color;

uniform vec4 uView;  // map -> clip: scale.xy, offset.xy

out vec2 v_local;
out vec4 v_color;
out vec4 v_params;   // half width, length, glow radius, dash period

void main() {
  vec2 d = i_seg.zw - i_seg.xy;
  float len = max(length(d), 0.0001);
  vec2 dir = d / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float halfW = 0.5 * i_style.x;
  float pad = halfW + 2.0 + 2.5 * i_style.y;
  float along = a_corner.x < 0.0 ? -pad : len + pad;
  vec2 pos = i_seg.xy + dir * along + nrm * a_corner.y * pad;
  gl_Position = vec4(pos * uView.xy + uView.zw, 0.0, 1.0);
  v_local = vec2(along, a_corner.y * pad);
  v_color = i_color;
  v_params = vec4(halfW, len, i_style.y, i_style.z);
}
#endif

#ifdef FRAGMENT
precision highp float;
in vec2 v_local;
in vec4 v_color;
in vec4 v_params;
uniform float uPxPerUnit;
uniform vec2 uEmissive;  // gain per glow radius unit, gain cap
out vec4 o_color;

void main() {
  float halfW = v_params.x;
  float len = v_params.y;
  float glowR = v_params.z;
  float dash = v_params.w;
  float dx = v_local.x - clamp(v_local.x, 0.0, len);
  float d = length(vec2(dx, v_local.y));
  float aa = 1.0 / uPxPerUnit;
  float core = 1.0 - smoothstep(halfW - aa, halfW + aa, d);
  if (dash > 0.0) {
    float on = step(fract(v_local.x / dash), 0.55);
    core *= on;
  }
  float glow = 0.0;
  if (glowR > 0.0) {
    float e = max(d - halfW, 0.0) / glowR;
    glow = 0.55 * exp(-1.4 * e * e);
  }
  // A glowing primitive emits its core brighter than white; the bloom pass picks that up.
  float gain = glowR > 0.0 ? 1.0 + min(uEmissive.x * glowR, uEmissive.y) : 1.0;
  float cov = clamp(core + glow * 0.5, 0.0, 1.0) * v_color.a;
  vec3 rgb = v_color.rgb * (core * gain + glow) * v_color.a;
  o_color = vec4(rgb, cov);
}
#endif
