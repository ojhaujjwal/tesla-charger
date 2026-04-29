import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    expect: {
      requireAssertions: true
    },
    exclude: [
      "repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/coverage/**"
    ]
  }
});
