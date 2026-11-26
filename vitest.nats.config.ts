import { defineConfig } from "vitest/config";

/** Integration tests against a real nats-server with JetStream (CI downloads the binary). */
export default defineConfig({
  test: { include: ["test/nats/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
