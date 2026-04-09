import type { MeshCapability, MeshNeighborNode, MeshRuntimeType } from "./mesh-types.js";

interface NeighborThresholds {
  suspectThreshold: number;
  offlineThreshold: number;
}

interface TouchInput {
  nodeId: string;
  runtimeType: MeshRuntimeType;
  skills: string[];
  peerName?: string | null;
  latencyMs?: number | null;
  capabilities?: MeshCapability[];
}

export class MeshNeighborRegistry {
  private readonly nodes = new Map<string, MeshNeighborNode>();
  private readonly thresholds: NeighborThresholds;

  constructor(thresholds: NeighborThresholds) {
    this.thresholds = {
      suspectThreshold: Math.max(1, Math.floor(thresholds.suspectThreshold)),
      offlineThreshold: Math.max(1, Math.floor(thresholds.offlineThreshold)),
    };
  }

  seed(peerName: string): void {
    if (!peerName.trim()) return;
    const nodeId = peerName.trim();
    if (this.nodes.has(nodeId)) return;

    this.nodes.set(nodeId, {
      nodeId,
      runtimeType: "openclaw",
      skills: [],
      status: "offline",
      lastSeenAt: null,
      missCount: this.thresholds.offlineThreshold,
      latencyMs: null,
      peerName,
      costHint: 1,
      latencyHint: 1,
    });
  }

  upsertOnline(input: TouchInput): MeshNeighborNode {
    const now = Date.now();
    const existing = this.nodes.get(input.nodeId);
    const capabilityMetrics = summarizeCapabilityHints(input.capabilities || []);
    const next: MeshNeighborNode = {
      nodeId: input.nodeId,
      runtimeType: input.runtimeType,
      skills: dedupeStrings(input.skills),
      status: "online",
      lastSeenAt: now,
      missCount: 0,
      latencyMs: input.latencyMs ?? existing?.latencyMs ?? null,
      peerName: input.peerName ?? existing?.peerName ?? null,
      costHint: capabilityMetrics.costHint ?? existing?.costHint ?? 1,
      latencyHint: capabilityMetrics.latencyHint ?? existing?.latencyHint ?? 1,
    };
    this.nodes.set(input.nodeId, next);
    return next;
  }

  recordFailure(nodeId: string): MeshNeighborNode | undefined {
    const current = this.nodes.get(nodeId);
    if (!current) return undefined;

    const nextMissCount = current.missCount + 1;
    const status = nextMissCount >= this.thresholds.offlineThreshold
      ? "offline"
      : nextMissCount >= this.thresholds.suspectThreshold
        ? "suspect"
        : "online";

    const next: MeshNeighborNode = {
      ...current,
      missCount: nextMissCount,
      status,
    };
    this.nodes.set(nodeId, next);
    return next;
  }

  updatePeerName(nodeId: string, peerName: string): void {
    const current = this.nodes.get(nodeId);
    if (!current) return;
    this.nodes.set(nodeId, { ...current, peerName });
  }

  get(nodeId: string): MeshNeighborNode | undefined {
    return this.nodes.get(nodeId);
  }

  list(): MeshNeighborNode[] {
    return [...this.nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  listOnline(): MeshNeighborNode[] {
    return this.list().filter((n) => n.status === "online");
  }
}

function dedupeStrings(values: string[]): string[] {
  const result: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const normalized = v.trim();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

function summarizeCapabilityHints(capabilities: MeshCapability[]): { costHint?: number; latencyHint?: number } {
  if (!capabilities.length) return {};
  let costSum = 0;
  let latencySum = 0;
  let count = 0;
  for (const item of capabilities) {
    costSum += Number.isFinite(item.costHint) ? item.costHint : 1;
    latencySum += Number.isFinite(item.latencyHint) ? item.latencyHint : 1;
    count += 1;
  }
  if (count === 0) return {};
  return {
    costHint: Number((costSum / count).toFixed(3)),
    latencyHint: Number((latencySum / count).toFixed(3)),
  };
}
