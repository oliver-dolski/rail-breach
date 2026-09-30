// Node, signal and halo glyphs as instanced quads with a signed distance field
// per shape. Shape is told apart by outline as well as colour.
#ifdef VERTEX
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 i_pos;    // x y radius shape
layout(location = 2) in float i_glow;  // glow radius
layout(location = 3) in vec4 i_color;

uniform vec4 uView;

out vec2 v_local;
out vec4 v_color;
out vec4 v_params;  // radius, glow radius, shape

void main() {
  float r = i_pos.z;
  float pad = r * 1.4 + 2.0 + 2.5 * i_glow;
  vec2 pos = i_pos.xy + a_corner * pad;
  gl_Position = vec4(pos * uView.xy + uView.zw, 0.0, 1.0);
  v_local = a_corner * pad;
  v_color = i_color;
  v_params = vec4(r, i_glow, i_pos.w, 0.0);
}
#endif

#ifdef FRAGMENT
precision highp float;
in vec2 v_local;
in vec4 v_color;
in vec4 v_params;
uniform float uPxPerUnit;
out vec4 o_color;

float sdBox(vec2 p, vec2 b) {
  vec2 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float sdTriangle(vec2 p, float r) {
  const float k = 1.7320508;
  p.y = -p.y;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) * 0.5;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float shapeDistance(int shape, vec2 p, float r) {
  if (shape == 1) return abs(length(p) - r * 0.72) - r * 0.26;
  if (shape == 2) return (abs(p.x) + abs(p.y) - r * 1.15) * 0.70710678;
  if (shape == 3) return sdTriangle(p, r * 0.92);
  if (shape == 4) {
    vec2 q = vec2(p.x + p.y, p.x - p.y) * 0.70710678;
    vec2 b = vec2(r * 1.2, r * 0.3);
    return min(sdBox(q, b), sdBox(q.yx, b));
  }
  return length(p) - r;
}

void main() {
  float r = v_params.x;
  float glowR = v_params.y;
  int shape = int(v_params.z + 0.5);
  float d = shapeDistance(shape, v_local, r);
  float aa = 1.0 / uPxPerUnit;
  float core = 1.0 - smoothstep(-aa, aa, d);
  float glow = 0.0;
  if (glowR > 0.0) {
    float e = max(d, 0.0) / glowR;
    glow = 0.6 * exp(-1.4 * e * e);
  }
  float cov = clamp(core + glow * 0.5, 0.0, 1.0) * v_color.a;
  vec3 rgb = v_color.rgb * (core + glow) * v_color.a;
  o_color = vec4(rgb, cov);
}
#endif
