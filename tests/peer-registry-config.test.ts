import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../index.ts";

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

describe("peer registry config", () => {
  it("is disabled by default", () => {
    const config = parseConfig({});
    assert.equal(config.peerRegistry, undefined);
  });

  it("parses peerRegistry.filePath and poll interval", () => {
    const config = parseConfig({
      peerRegistry: {
        filePath: "data/mesh-peers.json",
        pollIntervalMs: 2500,
      },
    });

    assert.ok(config.peerRegistry);
    assert.ok(normalizePath(config.peerRegistry!.filePath).endsWith("/data/mesh-peers.json"));
    assert.equal(config.peerRegistry!.pollIntervalMs, 2500);
  });

  it("supports legacy peerRegistryFile and clamps poll interval to >= 1000ms", () => {
    const config = parseConfig({
      peerRegistryFile: "data/mesh-peers.json",
      peerRegistry: {
        pollIntervalMs: 200,
      },
    });

    assert.ok(config.peerRegistry);
    assert.ok(normalizePath(config.peerRegistry!.filePath).endsWith("/data/mesh-peers.json"));
    assert.equal(config.peerRegistry!.pollIntervalMs, 1000);
  });
});

