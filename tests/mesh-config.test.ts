import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../index.js";

describe("parseConfig mesh defaults", () => {
  it("provides default mesh config when absent", () => {
    const config = parseConfig({});
    assert.equal(config.mesh.enabled, false);
    assert.equal(config.mesh.runtimeType, "openclaw");
    assert.equal(config.mesh.heartbeat.intervalMs, 5000);
    assert.equal(config.mesh.heartbeat.suspectThreshold, 3);
    assert.equal(config.mesh.heartbeat.offlineThreshold, 5);
    assert.equal(config.mesh.scheduler.maxFanout, 4);
    assert.equal(config.mesh.scheduler.fullMeshMaxNodes, 6);
    assert.ok(Array.isArray(config.mesh.capabilities));
  });

  it("parses mesh seed peers and scheduler config", () => {
    const config = parseConfig({
      agentCard: {
        skills: [{ id: "analysis", name: "analysis" }],
      },
      mesh: {
        enabled: true,
        nodeId: "node-a",
        runtimeType: "openclaw",
        seedPeers: [
          {
            name: "node-b",
            agentCardUrl: "http://127.0.0.1:18801/.well-known/agent-card.json",
            auth: { type: "bearer", token: "abc" },
          },
        ],
        heartbeat: {
          intervalMs: 4000,
          suspectThreshold: 2,
          offlineThreshold: 4,
        },
        scheduler: {
          maxFanout: 3,
          fullMeshMaxNodes: 5,
        },
      },
    });

    assert.equal(config.mesh.enabled, true);
    assert.equal(config.mesh.nodeId, "node-a");
    assert.equal(config.mesh.seedPeers.length, 1);
    assert.equal(config.mesh.seedPeers[0].name, "node-b");
    assert.equal(config.mesh.heartbeat.intervalMs, 4000);
    assert.equal(config.mesh.scheduler.maxFanout, 3);
    assert.equal(config.mesh.scheduler.fullMeshMaxNodes, 5);
  });
});
