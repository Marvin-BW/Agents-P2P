import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MeshNeighborRegistry } from "../src/mesh-neighbors.js";

describe("MeshNeighborRegistry", () => {
  it("transitions online -> suspect -> offline after consecutive failures", () => {
    const registry = new MeshNeighborRegistry({
      suspectThreshold: 3,
      offlineThreshold: 5,
    });

    registry.upsertOnline({
      nodeId: "n1",
      runtimeType: "openclaw",
      skills: ["analysis"],
      peerName: "peer-1",
      latencyMs: 42,
    });

    assert.equal(registry.get("n1")?.status, "online");
    registry.recordFailure("n1");
    registry.recordFailure("n1");
    assert.equal(registry.get("n1")?.status, "online");
    registry.recordFailure("n1");
    assert.equal(registry.get("n1")?.status, "suspect");
    registry.recordFailure("n1");
    registry.recordFailure("n1");
    assert.equal(registry.get("n1")?.status, "offline");
  });

  it("resets missCount and status on success", () => {
    const registry = new MeshNeighborRegistry({
      suspectThreshold: 2,
      offlineThreshold: 3,
    });

    registry.upsertOnline({
      nodeId: "n2",
      runtimeType: "openclaw",
      skills: [],
    });
    registry.recordFailure("n2");
    registry.recordFailure("n2");
    assert.equal(registry.get("n2")?.status, "suspect");

    registry.upsertOnline({
      nodeId: "n2",
      runtimeType: "openclaw",
      skills: ["chat"],
      latencyMs: 8,
    });
    const node = registry.get("n2");
    assert.equal(node?.status, "online");
    assert.equal(node?.missCount, 0);
    assert.equal(node?.latencyMs, 8);
  });
});
