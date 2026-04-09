import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chooseMeshTopology,
  inferMeshTemplate,
  scoreMeshNode,
  selectMeshNodes,
} from "../src/mesh-scheduler.js";
import type { MeshNeighborNode } from "../src/mesh-types.js";

const schedulerConfig = {
  maxFanout: 4,
  fullMeshMaxNodes: 6,
};

describe("mesh scheduler", () => {
  it("infers template from goal text", () => {
    assert.equal(inferMeshTemplate("Please review this architecture design"), "review");
    assert.equal(inferMeshTemplate("Build a deployment plan"), "build");
    assert.equal(inferMeshTemplate("Analyze this incident"), "analyze");
  });

  it("chooses topology according to template and node count", () => {
    assert.equal(chooseMeshTopology("build", 4, schedulerConfig), "serial");
    assert.equal(chooseMeshTopology("analyze", 4, schedulerConfig), "star");
    assert.equal(chooseMeshTopology("review", 5, schedulerConfig), "full-mesh");
    assert.equal(chooseMeshTopology("review", 8, schedulerConfig), "star");
  });

  it("scores and selects nodes with skill affinity", () => {
    const nodes: MeshNeighborNode[] = [
      {
        nodeId: "a",
        runtimeType: "openclaw",
        skills: ["analysis", "review"],
        status: "online",
        lastSeenAt: Date.now(),
        missCount: 0,
        latencyMs: 35,
        peerName: "peer-a",
        costHint: 1,
        latencyHint: 1,
      },
      {
        nodeId: "b",
        runtimeType: "openclaw",
        skills: ["build"],
        status: "online",
        lastSeenAt: Date.now(),
        missCount: 0,
        latencyMs: 120,
        peerName: "peer-b",
        costHint: 1.2,
        latencyHint: 1.1,
      },
      {
        nodeId: "c",
        runtimeType: "ollama-adapter",
        skills: ["review", "analysis"],
        status: "online",
        lastSeenAt: Date.now(),
        missCount: 0,
        latencyMs: 55,
        peerName: "peer-c",
        costHint: 0.9,
        latencyHint: 0.9,
      },
    ];

    assert.ok(scoreMeshNode(nodes[0], ["analysis"]) > scoreMeshNode(nodes[1], ["analysis"]));
    const selected = selectMeshNodes(nodes, ["analysis"], 2);
    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map((n) => n.nodeId), ["a", "c"]);
  });
});