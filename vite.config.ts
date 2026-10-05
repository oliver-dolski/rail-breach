import { defineConfig } from "vitest/config";

export default defineConfig({
  // Project page: https://oliver-dolski.github.io/rail-breach/
  base: "/rail-breach/",
  build: { target: "es2022", sourcemap: false },
  plugins: [
    {
      // index.html carries the strict production policy. The dev server injects its
      // styles and talks to the page over a websocket, so only there it is relaxed.
      name: "rail-breach-dev-csp",
      apply: "serve",
      transformIndexHtml(html) {
        return html
          .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
          .replace("connect-src 'self'", "connect-src 'self' ws: http:");
      },
    },
  ],
  test: {
    // Node, not jsdom: the core must stay DOM-free and a DOM environment would hide leaks.
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // The slowest test takes about 2 s alone (a whole scenario played through) and the ones that
    // start a child process or a server about 0.1 s, but with every worker busy in a full run each
    // of them has gone past the default 5 s. The limit is there to catch a hang, not to time them.
    testTimeout: 20_000,
  },
});
