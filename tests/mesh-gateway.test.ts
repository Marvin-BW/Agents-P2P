import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHarness, invokeGatewayMethod, makeConfig } from "./helpers.js";

describe("mesh gateway methods", () => {
  it("exposes mesh node/neighbors/task methods when mesh is enabled", async () => {
    const harness = createHarness(makeConfig({
      mesh: {
        enabled: true,
        nodeId: "node-local",
        runtimeType: "openclaw",
        seedPeers: [],
        coordinator: { fallbackNodeId: "" },
        heartbeat: { intervalMs: 5000, suspectThreshold: 3, offlineThreshold: 5 },
        scheduler: { maxFanout: 4, fullMeshMaxNodes: 6 },
        capabilities: [
          { skillId: "analysis", tags: ["analysis"], runtimeType: "openclaw", costHint: 1, latencyHint: 1 },
        ],
      },
    }));

    const status = await invokeGatewayMethod(harness, "mesh.node.status", {});
    assert.equal(status.ok, true);
    assert.equal((status.data as Record<string, unknown>).nodeId, "node-local");

    const submit = await invokeGatewayMethod(harness, "mesh.task.submit", {
      goal: "Analyze latest logs and summarize findings",
      template: "auto",
      requiredSkills: ["analysis"],
    });
    assert.equal(submit.ok, true);
    const submitData = submit.data as Record<string, unknown>;
    assert.equal(typeof submitData.meshTaskId, "string");
    assert.ok(["DONE", "FAILED"].includes(String(submitData.state)));

    const taskStatus = await invokeGatewayMethod(harness, "mesh.task.status", {
      meshTaskId: submitData.meshTaskId,
    });
    assert.equal(taskStatus.ok, true);
    const task = taskStatus.data as Record<string, unknown>;
    assert.equal(task.meshTaskId, submitData.meshTaskId);
    assert.equal(Array.isArray(task.stages), true);
  });
});
