// Half-resolution bloom: bright pass, separable blur, composite. One file, three
// passes chosen with PASS_BRIGHT, PASS_BLUR and PASS_COMPOSITE.
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
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uStrength;
out vec4 o_color;

void main() {
#ifdef PASS_BRIGHT
  vec3 c = texture(uTex, v_uv).rgb;
  float peak = max(c.r, max(c.g, c.b));
  float k = smoothstep(0.6, 1.0, peak);
  o_color = vec4(c * k, 1.0);
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
  vec3 bloom = texture(uBloom, v_uv).rgb;
  vec2 q = v_uv - 0.5;
  float vignette = 1.0 - 0.35 * dot(q, q) * 2.0;
  o_color = vec4((scene + bloom * uStrength) * vignette, 1.0);
#endif
}
#endif
