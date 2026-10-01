// Zone panels: translucent rounded rectangles with a vertical fill gradient, a solid lit
// border, a soft light just inside the border and, for a tinted zone, an outer glow.
// Shape and alpha only: nothing in here reads the clock.
#ifdef VERTEX
layout(location = 0) in vec2 a_corner;   // -1..1 over the padded rectangle
layout(location = 1) in vec4 i_rect;     // x y w h in map units
layout(location = 2) in vec4 i_shape;    // radius, border, inner glow width, outer glow radius
layout(location = 3) in vec4 i_fill;     // rgb, alpha at the top edge
layout(location = 4) in vec4 i_edge;     // rgb, alpha on the sides and bottom
layout(location = 5) in vec3 i_more;     // alpha at the bottom edge, alpha on the top edge, inner glow alpha

#ifdef MATRIX
uniform mat4 uMatrix;  // the intro: a map point (x, y, 0) to clip space, tilt and perspective included
#else
uniform vec4 uView;  // map -> clip: scale.xy, offset.xy
#endif

out vec2 v_local;    // offset from the rectangle's centre, map units
out vec4 v_box;      // half width, half height, radius, border
out vec4 v_glow;     // inner glow width, outer glow radius, inner glow alpha, top edge alpha
out vec4 v_fill;
out vec4 v_edge;
out float v_bottom;  // fill alpha at the bottom edge

void main() {
  vec2 half_ = 0.5 * i_rect.zw;
  float pad = i_shape.y + 2.0 + 2.5 * i_shape.w;
  vec2 centre = i_rect.xy + half_;
  vec2 local = a_corner * (half_ + pad);
  #ifdef MATRIX
  gl_Position = uMatrix * vec4(centre + local, 0.0, 1.0);
#else
  gl_Position = vec4((centre + local) * uView.xy + uView.zw, 0.0, 1.0);
#endif
  v_local = local;
  v_box = vec4(half_, i_shape.x, i_shape.y);
  v_glow = vec4(i_shape.z, i_shape.w, i_more.z, i_more.y);
  v_fill = i_fill;
  v_edge = i_edge;
  v_bottom = i_more.x;
}
#endif

#ifdef FRAGMENT
precision highp float;
in vec2 v_local;
in vec4 v_box;
in vec4 v_glow;
in vec4 v_fill;
in vec4 v_edge;
in float v_bottom;
uniform float uPxPerUnit;
uniform vec2 uEmissive;  // gain per glow radius unit, gain cap
#ifdef MATRIX
uniform float uAlpha;    // the intro fades its layers in; premultiplied output scales whole
#endif
out vec4 o_color;

// Signed distance to a rounded box: negative inside.
float sdRoundBox(vec2 p, vec2 half_, float r) {
  vec2 q = abs(p) - half_ + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 half_ = v_box.xy;
  float radius = v_box.z;
  float border = v_box.w;
  float innerWidth = v_glow.x;
  float outerR = v_glow.y;
  float innerAlpha = v_glow.z;
  float edgeTop = v_glow.w;
  float aa = 1.0 / uPxPerUnit;

  float d = sdRoundBox(v_local, half_, radius);
  float inside = 1.0 - smoothstep(-aa, aa, d);

  // Fill: a vertical gradient from the top edge (small y on the sheet) to the bottom edge.
  float t = clamp((v_local.y + half_.y) / (2.0 * half_.y), 0.0, 1.0);
  float fillA = mix(v_fill.a, v_bottom, t) * inside;

  // Border: the band between the outline and `border` units inside it. The top edge is the
  // brightest; the sides ease down to their own alpha within a few units of the corner.
  float band = inside * smoothstep(-border - aa, -border + aa, d);
  float fromTop = v_local.y + half_.y;
  float edgeA = mix(edgeTop, v_edge.a, smoothstep(border, border * 3.0 + radius, fromTop));

  // Light just inside the border.
  float depth = max(-d - border, 0.0);
  float innerG = inside * innerAlpha * exp(-3.0 * pow(depth / max(innerWidth, 0.001), 2.0));

  // Outer glow of a tinted zone.
  float outerG = 0.0;
  if (outerR > 0.0) {
    float e = max(d, 0.0) / outerR;
    outerG = 0.45 * exp(-1.4 * e * e) * (1.0 - inside);
  }

  // A glowing border emits brighter than white like every other glowing primitive.
  float gain = outerR > 0.0 ? 1.0 + min(uEmissive.x * outerR, uEmissive.y) : 1.0;
  vec3 rgb = v_fill.rgb * fillA
           + v_edge.rgb * (band * edgeA * gain)
           + v_edge.rgb * innerG
           + v_edge.rgb * outerG;
  float cov = clamp(fillA + band * edgeA + innerG + outerG * 0.6, 0.0, 1.0);
  o_color = vec4(rgb, cov);
#ifdef MATRIX
  o_color *= uAlpha;
#endif
}
#endif
