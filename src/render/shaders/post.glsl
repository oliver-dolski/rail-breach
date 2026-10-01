// Bloom chain: bright pass, downsample, separable blur, composite. One file, four
// passes chosen with PASS_BRIGHT, PASS_DOWN, PASS_BLUR and PASS_COMPOSITE. Nothing in
// here reads the clock: the dither is a hash of the pixel position only, so two runs of
// the same frame are byte-identical.
#ifdef VERTEX
out vec2 v_uv;
void main() {
  // One oversized triangle covers the screen without any vertex buffer.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
#endif

#ifdef FRAGMENT
precision highp float;
in vec2 v_uv;
uniform sampler2D uTex;
uniform sampler2D uBloom1;
uniform sampler2D uBloom2;
uniform sampler2D uBloom3;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform vec2 uThreshold;
uniform vec3 uWeights;
uniform int uLevels;
uniform float uStrength;
uniform float uKnee;
uniform float uVignette;
out vec4 o_color;

// Identity up to the knee, a tanh shoulder above it. A knee of 1 switches it off.
vec3 shoulder(vec3 c) {
  if (uKnee >= 1.0) return c;
  float room = 1.0 - uKnee;
  vec3 over = max(c - uKnee, 0.0);
  vec3 curved = uKnee + room * tanh(over / room);
  return mix(c, curved, step(vec3(uKnee), c));
}

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Triangular noise of one 8-bit step, from the pixel position and nothing else.
vec3 dither(vec2 fragCoord) {
  uvec2 p = uvec2(fragCoord);
  uint h0 = pcg(p.x + pcg(p.y));
  uint h1 = pcg(h0 + 1013904223u);
  vec3 a = vec3(float(h0 & 1023u), float((h0 >> 10u) & 1023u), float((h0 >> 20u) & 1023u)) / 1023.0;
  vec3 b = vec3(float(h1 & 1023u), float((h1 >> 10u) & 1023u), float((h1 >> 20u) & 1023u)) / 1023.0;
  return (a + b - 1.0) / 255.0;
}

void main() {
#ifdef PASS_BRIGHT
  vec3 c = texture(uTex, v_uv).rgb;
  float peak = max(c.r, max(c.g, c.b));
  float k = smoothstep(uThreshold.x, uThreshold.y, peak);
  o_color = vec4(c * k, 1.0);
#endif
#ifdef PASS_DOWN
  // Four taps at the corners of the source texel block: a box average of the level above.
  vec3 d = texture(uTex, v_uv + uTexel * vec2(-0.5, -0.5)).rgb;
  d += texture(uTex, v_uv + uTexel * vec2(0.5, -0.5)).rgb;
  d += texture(uTex, v_uv + uTexel * vec2(-0.5, 0.5)).rgb;
  d += texture(uTex, v_uv + uTexel * vec2(0.5, 0.5)).rgb;
  o_color = vec4(d * 0.25, 1.0);
#endif
#ifdef PASS_BLUR
  vec3 sum = texture(uTex, v_uv).rgb * 0.227027;
  sum += texture(uTex, v_uv + uDir * uTexel * 1.3846).rgb * 0.3162162;
  sum += texture(uTex, v_uv - uDir * uTexel * 1.3846).rgb * 0.3162162;
  sum += texture(uTex, v_uv + uDir * uTexel * 3.2308).rgb * 0.0702703;
  sum += texture(uTex, v_uv - uDir * uTexel * 3.2308).rgb * 0.0702703;
  o_color = vec4(sum, 1.0);
#endif
#ifdef PASS_COMPOSITE
  vec3 scene = texture(uTex, v_uv).rgb;
  vec3 bloom = texture(uBloom1, v_uv).rgb * uWeights.x;
  if (uLevels >= 2) bloom += texture(uBloom2, v_uv).rgb * uWeights.y;
  if (uLevels >= 3) bloom += texture(uBloom3, v_uv).rgb * uWeights.z;
  vec3 hdr = scene + bloom * uStrength;
  vec2 q = v_uv - 0.5;
  float vignette = 1.0 - uVignette * dot(q, q) * 2.0;
  vec3 shown = shoulder(hdr) * vignette;
  o_color = vec4(shown + dither(gl_FragCoord.xy), 1.0);
#endif
}
#endif
