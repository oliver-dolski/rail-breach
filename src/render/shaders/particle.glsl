// Packet particles, positioned on the GPU from the simulation clock. One-shot
// particles travel from p0 to p1 once; looping ones carry ambient traffic.
#ifdef VERTEX
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 i_seg;     // x0 y0 x1 y1
layout(location = 2) in vec4 i_timing;  // start time (s), duration (s), size, loop flag
layout(location = 3) in vec4 i_color;

#ifdef MATRIX
uniform mat4 uMatrix;
uniform float uAlpha;  // the intro fades its ambient traffic in
#else
uniform vec4 uView;
#endif
uniform float uSimTime;

out vec2 v_local;
out vec4 v_color;
out float v_size;

void main() {
  float phase = (uSimTime - i_timing.x) / max(i_timing.y, 0.001);
  if (i_timing.w > 0.5) phase = fract(phase);
  float alive = step(0.0, phase) * step(phase, 1.0);
  float size = i_timing.z;
  float pad = size * 3.2;
  vec2 center = mix(i_seg.xy, i_seg.zw, clamp(phase, 0.0, 1.0));
  vec2 pos = center + a_corner * pad * alive;
  #ifdef MATRIX
  gl_Position = uMatrix * vec4(pos, 0.0, 1.0);
#else
  gl_Position = vec4(pos * uView.xy + uView.zw, 0.0, 1.0);
#endif
  v_local = a_corner * pad;
  float fade = smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.92, 1.0, phase));
#ifdef MATRIX
  v_color = vec4(i_color.rgb, i_color.a * alive * fade * uAlpha);
#else
  v_color = vec4(i_color.rgb, i_color.a * alive * fade);
#endif
  v_size = size;
}
#endif

#ifdef FRAGMENT
precision highp float;
in vec2 v_local;
in vec4 v_color;
in float v_size;
out vec4 o_color;

void main() {
  float d = length(v_local) / v_size;
  float core = exp(-d * d * 1.6);
  float halo = 0.35 * exp(-d * d * 0.25);
  float a = (core + halo) * v_color.a;
  // Alpha 0 with the (ONE, ONE_MINUS_SRC_ALPHA) blend is the same sum as an additive blend, and it
  // is the form that adds up the same way on every run when the target is half-float: a plain
  // (ONE, ONE) blend into RGBA16F gave a different last bit from one session to the next.
  o_color = vec4(v_color.rgb * a, 0.0);
}
#endif
