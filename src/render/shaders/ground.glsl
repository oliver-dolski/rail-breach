// A dot grid on the map sheet, drawn first so everything else lies over it. The fragment
// maps its pixel back into map units through the inverse of uView, so the grid is fixed to
// the map and a moving camera has something to move against. Position only, no clock.
#ifdef VERTEX
void main() {
  // One oversized triangle covers the screen without any vertex buffer.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
#endif

#ifdef FRAGMENT
precision highp float;
uniform vec4 uView;      // map -> clip: scale.xy, offset.xy
uniform vec2 uCanvas;    // render target size in pixels
uniform vec2 uSheet;     // sheet size in map units
uniform float uPxPerUnit;
uniform vec4 uDot;       // rgb, alpha
out vec4 o_color;

const float PITCH = 24.0;
const float RADIUS = 1.0;

void main() {
  vec2 ndc = gl_FragCoord.xy / uCanvas * 2.0 - 1.0;
  vec2 pos = (ndc - uView.zw) / uView.xy;
  if (pos.x < 0.0 || pos.y < 0.0 || pos.x > uSheet.x || pos.y > uSheet.y) {
    o_color = vec4(0.0);
    return;
  }
  vec2 centre = (floor(pos / PITCH) + 0.5) * PITCH;
  float aa = 1.0 / uPxPerUnit;
  float dotMask = 1.0 - smoothstep(RADIUS - aa, RADIUS + aa, length(pos - centre));
  float a = dotMask * uDot.a;
  o_color = vec4(uDot.rgb * a, a);
}
#endif
