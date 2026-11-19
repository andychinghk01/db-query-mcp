#!/usr/bin/env bun
export {};

if (process.argv.length === 2) {
  await import("./server.js");
} else {
  await import("./cli.js");
}
