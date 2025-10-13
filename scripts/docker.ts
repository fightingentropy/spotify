#!/usr/bin/env bun

/**
 * Lightweight wrapper to invoke Docker Compose with Bun.
 *
 * Examples:
 *   bun run scripts/docker.ts up
 *   bun run scripts/docker.ts down
 */

const [, , ...args] = process.argv;

if (args.length === 0) {
  console.error("Usage: bun run scripts/docker.ts <command> [...options]");
  process.exit(1);
}

const [subcommand, ...rest] = args;

const composeArgs = [subcommand, ...rest];

if (subcommand === "up" && !rest.includes("-d") && !rest.includes("--detach")) {
  composeArgs.splice(1, 0, "-d");
}

const child = Bun.spawnSync({
  cmd: ["docker", "compose", ...composeArgs],
  stdout: "inherit",
  stderr: "inherit",
});

if (typeof child.exitCode === "number") {
  process.exit(child.exitCode);
}

console.error("Failed to run docker compose command.");
process.exit(1);
