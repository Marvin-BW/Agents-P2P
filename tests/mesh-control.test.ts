import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MeshNetworkManager } from "../src/mesh-control.js";
import { MESH_CONTROL_MIME, MESH_PROTOCOL_VERSION } from "../src/mesh-types.js";
import type { MeshConfig } from "../src/mesh-types.js";
import type { PeerConfig } from "../src/types.js";

const silentLogger = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
  error: (_msg: string) => {},
};

const meshConfig: MeshConfig = {
  enabled: true,
  nodeId: "node-worker-32",
  runtimeType: "openclaw",
  seedPeers: [],
  coordinator: { fallbackNodeId: "" },
  heartbeat: { intervalMs: 5000, suspectThreshold: 3, offlineThreshold: 5 },
  scheduler: { maxFanout: 4, fullMeshMaxNodes: 6 },
  capabilities: [
    { skillId: "analysis", tags: [], runtimeType: "openclaw", costHint: 1, latencyHint: 1 },
  ],
};

const localPeer: PeerConfig = {
  name: "node-worker-32",
  agentCardUrl: "http://127.0.0.1:18800/.well-known/agent.json",
};

describe("MeshNetworkManager TASK_OFFER handling", () => {
  it("returns real local execution output when local peer execution succeeds", async () => {
    const client = {
      async sendMessage() {
        return {
          ok: true,
          statusCode: 200,
          response: {
            kind: "message",
            parts: [{ kind: "text", text: "worker stage output: actionable review points" }],
          },
        };
      },
    };

    const manager = new MeshNetworkManager({
      config: meshConfig,
      localSkills: ["analysis", "review"],
      localCapabilities: meshConfig.capabilities,
      client: client as any,
      getPeers: () => [],
      localPeer,
      logger: silentLogger,
    });

    const handled = await manager.handleInboundControlMessage({
      kind: "message",
      parts: [{
        kind: "data",
        mimeType: MESH_CONTROL_MIME,
        data: {
          meshProtocolVersion: MESH_PROTOCOL_VERSION,
          type: "TASK_OFFER",
          meshTaskId: "task-1",
          fromNodeId: "node-coordinator-cloud",
          toNodeId: "node-worker-32",
          timestamp: new Date().toISOString(),
          payload: {
            goal: "Review architecture with action items",
            stageName: "parallel-review",
            requiredSkills: ["analysis", "review"],
          },
        },
      }],
    });

    assert.equal(handled.handled, true);
    assert.ok(handled.responseParts && handled.responseParts.length > 0);
    const responseEnvelope = (handled.responseParts?.[0] as any).data as Record<string, unknown>;
    assert.equal(responseEnvelope.type, "TASK_RESULT");
    assert.equal(
      (responseEnvelope.payload as Record<string, unknown>).output,
      "worker stage output: actionable review points",
    );
  });

  it("falls back to accepted placeholder when local peer execution fails", async () => {
    const client = {
      async sendMessage() {
        return {
          ok: false,
          statusCode: 502,
          response: { error: "upstream unavailable" },
        };
      },
    };

    const manager = new MeshNetworkManager({
      config: meshConfig,
      localSkills: ["analysis", "review"],
      localCapabilities: meshConfig.capabilities,
      client: client as any,
      getPeers: () => [],
      localPeer,
      logger: silentLogger,
    });

    const handled = await manager.handleInboundControlMessage({
      kind: "message",
      parts: [{
        kind: "data",
        mimeType: MESH_CONTROL_MIME,
        data: {
          meshProtocolVersion: MESH_PROTOCOL_VERSION,
          type: "TASK_OFFER",
          meshTaskId: "task-2",
          fromNodeId: "node-coordinator-cloud",
          toNodeId: "node-worker-32",
          timestamp: new Date().toISOString(),
          payload: {
            goal: "Review architecture with action items",
            stageName: "cross-review",
            requiredSkills: ["analysis", "review"],
          },
        },
      }],
    });

    assert.equal(handled.handled, true);
    assert.ok(handled.responseParts && handled.responseParts.length > 0);
    const responseEnvelope = (handled.responseParts?.[0] as any).data as Record<string, unknown>;
    assert.equal(responseEnvelope.type, "TASK_RESULT");
    const payload = responseEnvelope.payload as Record<string, unknown>;
    const output = String(payload.output || "");
    assert.ok(output.includes("accepted stage=cross-review"), `unexpected fallback output: ${output}`);
    assert.ok(output.includes("mode=fallback"), `missing fallback mode marker in output: ${output}`);
    assert.ok(output.includes("fallback=\""), `missing fallback reason in output: ${output}`);
  });
});
