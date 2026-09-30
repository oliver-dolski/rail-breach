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
  },
});
