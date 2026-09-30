import { defineConfig } from "vitest/config";

export default defineConfig({
  // Project page: https://oliver-dolski.github.io/rail-breach/
  base: "/rail-breach/",
  build: { target: "es2022", sourcemap: false },
  test: {
    // Node, not jsdom: the core must stay DOM-free and a DOM environment would hide leaks.
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
