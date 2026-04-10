import { randomUUID } from "node:crypto";

import type { Part } from "@a2a-js/sdk";

import { A2AClient } from "./client.js";
import { MeshNeighborRegistry } from "./mesh-neighbors.js";
import { chooseMeshTopology, inferMeshTemplate, selectMeshNodes } from "./mesh-scheduler.js";
import {
  MESH_CONTROL_MIME,
  MESH_PROTOCOL_VERSION,
  type MeshCapability,
  type MeshConfig,
  type MeshControlEnvelope,
  type MeshControlHandleResult,
  type MeshControlPlane,
  type MeshNeighborNode,
  type MeshTaskRecord,
  type MeshTaskSubmitInput,
  type MeshTaskSubmitResult,
  type MeshTemplate,
  type MeshTopology,
} from "./mesh-types.js";
import type { PeerConfig } from "./types.js";

type LoggerLike = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

interface MeshNetworkManagerOptions {
  config: MeshConfig;
  localSkills: string[];
  localCapabilities: MeshCapability[];
  client: A2AClient;
  getPeers: () => PeerConfig[];
  localPeer?: PeerConfig;
  logger: LoggerLike;
}

interface RemoteStageResult {
  ok: boolean;
  output: string;
  error?: string;
}

export class MeshNetworkManager implements MeshControlPlane {
  private readonly config: MeshConfig;
  private readonly localSkills: string[];
  private readonly localCapabilities: MeshCapability[];
  private readonly client: A2AClient;
  private readonly getPeers: () => PeerConfig[];
  private readonly localPeer?: PeerConfig;
  private readonly logger: LoggerLike;
  private readonly neighbors: MeshNeighborRegistry;
  private readonly tasks = new Map<string, MeshTaskRecord>();
  private readonly nodeIdToPeerName = new Map<string, string>();
  private readonly peerNameToNodeId = new Map<string, string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: MeshNetworkManagerOptions) {
    this.config = options.config;
    this.localSkills = [...new Set(options.localSkills)];
    this.localCapabilities = [...options.localCapabilities];
    this.client = options.client;
    this.getPeers = options.getPeers;
    this.localPeer = options.localPeer;
    this.logger = options.logger;
    this.neighbors = new MeshNeighborRegistry({
      suspectThreshold: options.config.heartbeat.suspectThreshold,
      offlineThreshold: options.config.heartbeat.offlineThreshold,
    });
  }

  async start(): Promise<void> {
    if (this.started || !this.config.enabled) return;
    this.started = true;

    for (const seed of this.config.seedPeers) {
      this.neighbors.seed(seed.name);
      this.nodeIdToPeerName.set(seed.name, seed.name);
      this.peerNameToNodeId.set(seed.name, seed.name);
    }

    await this.sendInitialAnnounce();
    await this.runHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat();
    }, this.config.heartbeat.intervalMs);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  getNodeStatus(): Record<string, unknown> {
    const neighborList = this.neighbors.list();
    return {
      enabled: this.config.enabled,
      started: this.started,
      nodeId: this.config.nodeId,
      runtimeType: this.config.runtimeType,
      skills: this.localSkills,
      capabilities: this.localCapabilities,
      neighbors: {
        total: neighborList.length,
        online: neighborList.filter((n) => n.status === "online").length,
        suspect: neighborList.filter((n) => n.status === "suspect").length,
        offline: neighborList.filter((n) => n.status === "offline").length,
      },
      tasks: {
        total: this.tasks.size,
        active: [...this.tasks.values()].filter((t) => t.state !== "DONE" && t.state !== "FAILED").length,
      },
      fallbackNodeId: this.config.coordinator.fallbackNodeId,
    };
  }

  listNeighbors(): MeshNeighborNode[] {
    return this.neighbors.list();
  }

  listTasks(): MeshTaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getTask(meshTaskId: string): MeshTaskRecord | undefined {
    return this.tasks.get(meshTaskId);
  }

  async submitTask(input: MeshTaskSubmitInput): Promise<MeshTaskSubmitResult> {
    const goal = asString(input.goal).trim();
    if (!goal) {
      throw new Error("goal is required");
    }
    const requiredSkills = normalizeStringArray(input.requiredSkills);
    const template = input.template && input.template !== "auto"
      ? input.template
      : inferMeshTemplate(goal);

    return this.submitTaskInternal(goal, requiredSkills, template);
  }

  async handleInboundControlMessage(message: unknown): Promise<MeshControlHandleResult> {
    const envelope = extractMeshEnvelope(message);
    if (!envelope) {
      return { handled: false };
    }

    if (envelope.toNodeId && envelope.toNodeId !== this.config.nodeId) {
      return {
        handled: true,
        responseParts: [
          this.buildDataPart(
            this.createFrame(
              "TASK_FAIL",
              { reason: `frame addressed to ${envelope.toNodeId}, current node is ${this.config.nodeId}` },
              envelope.meshTaskId,
              envelope.fromNodeId,
            ),
          ),
        ],
      };
    }

    switch (envelope.type) {
      case "ANNOUNCE":
        this.handleAnnounce(envelope);
        return { handled: true, responseParts: [this.buildDataPart(this.buildAnnounceFrame(envelope.fromNodeId))] };
      case "PING":
        this.handlePing(envelope);
        return { handled: true, responseParts: [this.buildDataPart(this.buildPongFrame(envelope.fromNodeId, envelope.payload))] };
      case "PONG":
        this.handlePong(envelope);
        return {
          handled: true,
          responseParts: [
            this.buildDataPart(
              this.createFrame(
                "TASK_ACCEPT",
                { ackFor: "PONG" },
                envelope.meshTaskId,
                envelope.fromNodeId,
              ),
            ),
          ],
        };
      case "TASK_OFFER":
        return { handled: true, responseParts: [this.buildDataPart(await this.handleTaskOffer(envelope))] };
      case "DELEGATE_TO_COORDINATOR":
        return { handled: true, responseParts: [this.buildDataPart(await this.handleDelegateRequest(envelope))] };
      case "TASK_ACCEPT":
      case "TASK_RESULT":
      case "TASK_FAIL":
        this.applyTaskControlFrame(envelope);
        return { handled: true, responseParts: [this.buildDataPart(this.createFrame("TASK_ACCEPT", { ackFor: envelope.type }, envelope.meshTaskId, envelope.fromNodeId))] };
      default:
        return { handled: true, responseParts: [this.buildDataPart(this.createFrame("TASK_FAIL", { reason: "unsupported frame type" }, envelope.meshTaskId, envelope.fromNodeId))] };
    }
  }

  private async submitTaskInternal(goal: string, requiredSkills: string[], template: MeshTemplate): Promise<MeshTaskSubmitResult> {
    const meshTaskId = randomUUID();
    const now = new Date().toISOString();

    const candidates = this.getEligibleNodes();
    const selectedCandidates = selectMeshNodes(
      candidates,
      requiredSkills,
      Math.max(2, this.config.scheduler.maxFanout + 1),
    );
    const withLocal = this.ensureLocalIncluded(selectedCandidates);
    const topology = chooseMeshTopology(template, withLocal.length, this.config.scheduler);

    const task: MeshTaskRecord = {
      meshTaskId,
      goal,
      requiredSkills,
      template,
      selectedTopology: topology,
      selectedNodes: withLocal.map((n) => n.nodeId),
      state: "RECEIVED",
      stages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(meshTaskId, task);

    try {
      task.state = "PLANNED";
      task.stages = createStages(template, topology, withLocal.map((n) => n.nodeId), this.config.nodeId);
      task.updatedAt = new Date().toISOString();

      const fallbackNodeId = this.config.coordinator.fallbackNodeId.trim();
      const canExecuteLocally = task.selectedNodes.length > 1 || !fallbackNodeId || fallbackNodeId === this.config.nodeId;
      if (!canExecuteLocally && fallbackNodeId && fallbackNodeId !== this.config.nodeId) {
        const delegated = await this.delegateTaskToCoordinator(task);
        task.state = delegated.ok ? "DONE" : "FAILED";
        task.finalResult = delegated.output;
        task.error = delegated.error;
        task.updatedAt = new Date().toISOString();
        return {
          meshTaskId,
          selectedTopology: topology,
          selectedNodes: task.selectedNodes,
          state: task.state,
        };
      }

      for (const stage of task.stages) {
        task.state = "DISPATCHING";
        stage.status = "dispatching";
        task.updatedAt = new Date().toISOString();

        for (const nodeId of stage.assignedNodeIds) {
          stage.attempts = Math.max(stage.attempts, 1);
          const result = await this.executeStageOnNode(task, stage.stageId, stage.name, nodeId);
          stage.results.push({ nodeId, ok: result.ok, output: result.output });
          if (!result.ok) {
            stage.attempts += 1;
            const failover = await this.tryOneRetry(task, stage.stageId, stage.name, nodeId);
            if (failover) {
              stage.results.push({ nodeId: failover.nodeId, ok: failover.ok, output: failover.output });
              if (!failover.ok) {
                throw new Error(failover.error || failover.output || "stage execution failed");
              }
            } else {
              throw new Error(result.error || result.output || "stage execution failed");
            }
          }
        }

        stage.status = "collecting";
        task.state = "COLLECTING";
        task.updatedAt = new Date().toISOString();
        stage.status = "done";
      }

      task.state = "MERGING";
      task.updatedAt = new Date().toISOString();
      task.finalResult = mergeStageResults(task);
      task.state = "DONE";
      task.updatedAt = new Date().toISOString();
    } catch (error: unknown) {
      task.state = "FAILED";
      task.error = error instanceof Error ? error.message : String(error);
      task.updatedAt = new Date().toISOString();
      this.logger.warn(`mesh.task.failed ${meshTaskId}: ${task.error}`);
    }

    return {
      meshTaskId,
      selectedTopology: topology,
      selectedNodes: task.selectedNodes,
      state: task.state,
    };
  }

  private async executeStageOnNode(
    task: MeshTaskRecord,
    stageId: string,
    stageName: string,
    nodeId: string,
  ): Promise<RemoteStageResult> {
    if (nodeId === this.config.nodeId) {
      return {
        ok: true,
        output: this.executeLocalStage(task, stageName),
      };
    }

    const peer = this.resolvePeerByNodeId(nodeId);
    if (!peer) {
      return {
        ok: false,
        output: "",
        error: `peer for node "${nodeId}" not found`,
      };
    }

    const frame = this.createFrame(
      "TASK_OFFER",
      {
        goal: task.goal,
        stageId,
        stageName,
        parentNodeId: this.config.nodeId,
        requiredSkills: task.requiredSkills,
      },
      task.meshTaskId,
      nodeId,
    );

    return this.sendControlFrameToPeer(peer, frame);
  }

  private async tryOneRetry(
    task: MeshTaskRecord,
    stageId: string,
    stageName: string,
    failedNodeId: string,
  ): Promise<(RemoteStageResult & { nodeId: string }) | null> {
    const alternatives = this.neighbors.listOnline()
      .filter((n) => n.nodeId !== failedNodeId)
      .map((n) => n.nodeId);
    for (const candidate of alternatives) {
      const retried = await this.executeStageOnNode(task, stageId, stageName, candidate);
      return { ...retried, nodeId: candidate };
    }
    return null;
  }

  private executeLocalStage(task: MeshTaskRecord, stageName: string): string {
    const skillText = task.requiredSkills.length > 0 ? task.requiredSkills.join(", ") : this.localSkills.join(", ");
    return `[mesh:${this.config.nodeId}] stage=${stageName} runtime=${this.config.runtimeType} goal="${truncate(task.goal, 220)}" skills=${skillText || "general"}`;
  }

  private async handleTaskOffer(envelope: MeshControlEnvelope): Promise<MeshControlEnvelope> {
    const goal = asString(envelope.payload.goal) || "unspecified goal";
    const stageName = asString(envelope.payload.stageName) || "task-offer";
    const requiredSkills = normalizeStringArray(envelope.payload.requiredSkills as unknown[]);

    const fallbackOutput = `[mesh:${this.config.nodeId}] accepted stage=${stageName}; goal="${truncate(goal, 220)}"; skills=${requiredSkills.join(", ") || this.localSkills.join(", ") || "general"}`;
    const accept = this.createFrame("TASK_ACCEPT", {
      acceptedBy: this.config.nodeId,
      stageName,
    }, envelope.meshTaskId, envelope.fromNodeId);
    this.applyTaskControlFrame(accept);

    const execution = await this.executeTaskOfferLocally(goal, stageName, requiredSkills);
    if (!execution.ok) {
      this.logger.warn(`mesh.task-offer.local-exec.failed node=${this.config.nodeId} stage=${stageName} reason=${execution.error || "unknown"}`);
    }

    return this.createFrame("TASK_RESULT", {
      stageName,
      output: execution.ok ? execution.output : fallbackOutput,
      acceptedBy: this.config.nodeId,
    }, envelope.meshTaskId, envelope.fromNodeId);
  }

  private async executeTaskOfferLocally(
    goal: string,
    stageName: string,
    requiredSkills: string[],
  ): Promise<RemoteStageResult> {
    if (!this.localPeer) {
      return {
        ok: false,
        output: "",
        error: "local peer is not configured",
      };
    }

    const skillText = requiredSkills.join(", ") || this.localSkills.join(", ") || "general";
    const prompt = [
      `You are mesh worker node "${this.config.nodeId}" (${this.config.runtimeType}).`,
      `Stage: ${stageName}`,
      `Task goal: ${goal}`,
      `Required skills: ${skillText}`,
      "Return only your stage result in plain text, concise and directly usable by the coordinator.",
    ].join("\n");

    try {
      const result = await this.client.sendMessage(this.localPeer, {
        role: "user",
        parts: [{ kind: "text", text: prompt }],
      });
      if (!result.ok) {
        return {
          ok: false,
          output: "",
          error: extractError(result.response) || `local stage execution failed on ${this.localPeer.name}`,
        };
      }

      const output = extractAnyText(result.response).trim();
      if (!output) {
        return {
          ok: false,
          output: "",
          error: "local stage execution returned empty output",
        };
      }

      return {
        ok: true,
        output,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async handleDelegateRequest(envelope: MeshControlEnvelope): Promise<MeshControlEnvelope> {
    const goal = asString(envelope.payload.goal);
    if (!goal) {
      return this.createFrame("TASK_FAIL", { reason: "missing goal" }, envelope.meshTaskId, envelope.fromNodeId);
    }
    const requiredSkills = normalizeStringArray(envelope.payload.requiredSkills as unknown[]);
    const rawTemplate = asString(envelope.payload.template) as MeshTemplate | "auto" | "";
    const template = rawTemplate && rawTemplate !== "auto" ? rawTemplate : inferMeshTemplate(goal);

    const result = await this.submitTaskInternal(goal, requiredSkills, template);
    const task = this.tasks.get(result.meshTaskId);
    if (!task || task.state !== "DONE") {
      return this.createFrame(
        "TASK_FAIL",
        { reason: task?.error || "delegate execution failed" },
        envelope.meshTaskId,
        envelope.fromNodeId,
      );
    }

    return this.createFrame("TASK_RESULT", {
      delegated: true,
      meshTaskId: task.meshTaskId,
      selectedTopology: task.selectedTopology,
      selectedNodes: task.selectedNodes,
      output: task.finalResult || "",
    }, envelope.meshTaskId, envelope.fromNodeId);
  }

  private applyTaskControlFrame(envelope: MeshControlEnvelope): void {
    if (!envelope.meshTaskId) return;
    const task = this.tasks.get(envelope.meshTaskId);
    if (!task) return;

    if (envelope.type === "TASK_FAIL") {
      task.state = "FAILED";
      task.error = asString(envelope.payload.reason) || "remote task failed";
      task.updatedAt = new Date().toISOString();
      return;
    }

    if (envelope.type === "TASK_RESULT") {
      const output = asString(envelope.payload.output);
      if (output) {
        task.finalResult = output;
      }
      task.updatedAt = new Date().toISOString();
    }
  }

  private async delegateTaskToCoordinator(task: MeshTaskRecord): Promise<RemoteStageResult> {
    const fallbackNodeId = this.config.coordinator.fallbackNodeId;
    const peer = this.resolvePeerByNodeId(fallbackNodeId);
    if (!peer) {
      return {
        ok: false,
        output: "",
        error: `fallback coordinator "${fallbackNodeId}" is not reachable`,
      };
    }
    const frame = this.createFrame("DELEGATE_TO_COORDINATOR", {
      goal: task.goal,
      requiredSkills: task.requiredSkills,
      template: task.template,
    }, task.meshTaskId, fallbackNodeId);
    return this.sendControlFrameToPeer(peer, frame);
  }

  private async sendInitialAnnounce(): Promise<void> {
    const peers = this.uniqueSeedPeers();
    await Promise.all(
      peers.map(async (peer) => {
        const frame = this.buildAnnounceFrame();
        const result = await this.sendControlFrameToPeer(peer, frame);
        if (!result.ok) {
          this.markPeerFailure(peer.name);
        }
      }),
    );
  }

  private async runHeartbeat(): Promise<void> {
    const peers = this.uniqueSeedPeers();
    await Promise.all(
      peers.map(async (peer) => {
        const pingFrame = this.createFrame("PING", {
          pingId: randomUUID(),
          sentAt: Date.now(),
        });

        const result = await this.sendControlFrameToPeer(peer, pingFrame);
        if (!result.ok) {
          this.markPeerFailure(peer.name);
          return;
        }

        const nodeId = this.peerNameToNodeId.get(peer.name) || peer.name;
        const existing = this.neighbors.get(nodeId);
        const runtimeType = existing?.runtimeType || "openclaw";
        this.neighbors.upsertOnline({
          nodeId,
          runtimeType,
          skills: existing?.skills || [],
          peerName: peer.name,
          latencyMs: this.safeLatencyFromResult(result.output, existing?.latencyMs ?? null),
        });
      }),
    );
  }

  private safeLatencyFromResult(output: string, fallback: number | null): number | null {
    const maybeNumber = Number(output);
    if (Number.isFinite(maybeNumber) && maybeNumber > 0 && maybeNumber < 300_000) {
      return maybeNumber;
    }
    return fallback;
  }

  private handleAnnounce(envelope: MeshControlEnvelope): void {
    const payload = envelope.payload;
    const runtimeType = normalizeRuntimeType(asString(payload.runtimeType));
    const skills = normalizeStringArray(payload.skills as unknown[]);
    const capabilities = normalizeCapabilities(payload.capabilities as unknown[], runtimeType);
    const node = this.neighbors.upsertOnline({
      nodeId: envelope.fromNodeId,
      runtimeType,
      skills,
      capabilities,
    });

    // Best-effort peer mapping: try existing exact-name peer first.
    if (!node.peerName) {
      const peer = this.getPeers().find((p) => p.name === envelope.fromNodeId);
      if (peer) {
        this.neighbors.updatePeerName(node.nodeId, peer.name);
        this.nodeIdToPeerName.set(node.nodeId, peer.name);
        this.peerNameToNodeId.set(peer.name, node.nodeId);
      }
    }
  }

  private handlePing(envelope: MeshControlEnvelope): void {
    const existing = this.neighbors.get(envelope.fromNodeId);
    this.neighbors.upsertOnline({
      nodeId: envelope.fromNodeId,
      runtimeType: existing?.runtimeType || "openclaw",
      skills: existing?.skills || [],
      peerName: existing?.peerName || null,
    });
  }

  private handlePong(envelope: MeshControlEnvelope): void {
    const existing = this.neighbors.get(envelope.fromNodeId);
    const sentAt = asNumber(envelope.payload.sentAt);
    const latencyMs = Number.isFinite(sentAt) && sentAt > 0 ? Math.max(1, Date.now() - sentAt) : existing?.latencyMs ?? null;
    this.neighbors.upsertOnline({
      nodeId: envelope.fromNodeId,
      runtimeType: existing?.runtimeType || "openclaw",
      skills: existing?.skills || [],
      peerName: existing?.peerName || null,
      latencyMs,
    });
  }

  private markPeerFailure(peerName: string): void {
    const nodeId = this.peerNameToNodeId.get(peerName) || peerName;
    this.neighbors.recordFailure(nodeId);
  }

  private uniqueSeedPeers(): PeerConfig[] {
    const peersByName = new Map<string, PeerConfig>();
    for (const peer of this.config.seedPeers) {
      peersByName.set(peer.name, peer);
    }
    for (const peer of this.getPeers()) {
      if (peersByName.has(peer.name)) {
        peersByName.set(peer.name, peer);
      }
    }
    return [...peersByName.values()];
  }

  private resolvePeerByNodeId(nodeId: string): PeerConfig | undefined {
    const peers = this.getPeers();
    const mappedName = this.nodeIdToPeerName.get(nodeId);
    if (mappedName) {
      const mappedPeer = peers.find((p) => p.name === mappedName);
      if (mappedPeer) return mappedPeer;
    }
    const direct = peers.find((p) => p.name === nodeId);
    if (direct) return direct;
    return undefined;
  }

  private buildAnnounceFrame(toNodeId?: string): MeshControlEnvelope {
    return this.createFrame("ANNOUNCE", {
      runtimeType: this.config.runtimeType,
      skills: this.localSkills,
      capabilities: this.localCapabilities,
    }, undefined, toNodeId);
  }

  private buildPongFrame(toNodeId: string | undefined, pingPayload: Record<string, unknown>): MeshControlEnvelope {
    return this.createFrame("PONG", {
      pingId: asString(pingPayload.pingId) || "",
      sentAt: asNumber(pingPayload.sentAt) || Date.now(),
      receivedAt: Date.now(),
      runtimeType: this.config.runtimeType,
    }, undefined, toNodeId);
  }

  private createFrame(
    type: MeshControlEnvelope["type"],
    payload: Record<string, unknown>,
    meshTaskId?: string,
    toNodeId?: string,
  ): MeshControlEnvelope {
    return {
      meshProtocolVersion: MESH_PROTOCOL_VERSION,
      type,
      ...(meshTaskId ? { meshTaskId } : {}),
      fromNodeId: this.config.nodeId,
      ...(toNodeId ? { toNodeId } : {}),
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  private buildDataPart(frame: MeshControlEnvelope): Part {
    return {
      kind: "data",
      mimeType: MESH_CONTROL_MIME,
      data: frame,
    };
  }

  private async sendControlFrameToPeer(peer: PeerConfig, frame: MeshControlEnvelope): Promise<RemoteStageResult> {
    const startedAt = Date.now();
    try {
      const result = await this.client.sendMessage(peer, {
        role: "user",
        parts: [this.buildDataPart(frame)],
      });

      if (!result.ok) {
        this.markPeerFailure(peer.name);
        return {
          ok: false,
          output: "",
          error: extractError(result.response) || `A2A send failed to ${peer.name}`,
        };
      }

      const responseEnvelope = extractMeshEnvelope(result.response);
      if (responseEnvelope) {
        this.rememberPeerMapping(peer.name, responseEnvelope.fromNodeId);
        if (responseEnvelope.type === "TASK_FAIL") {
          return {
            ok: false,
            output: "",
            error: asString(responseEnvelope.payload.reason) || "remote task failed",
          };
        }
        if (responseEnvelope.type === "PONG") {
          const sentAt = asNumber(responseEnvelope.payload.sentAt);
          const receivedAt = asNumber(responseEnvelope.payload.receivedAt);
          const latencyMs = sentAt > 0 && receivedAt >= sentAt
            ? Math.max(1, receivedAt - sentAt)
            : Math.max(1, Date.now() - startedAt);
          return { ok: true, output: String(latencyMs) };
        }
        if (responseEnvelope.type === "TASK_RESULT" || responseEnvelope.type === "ANNOUNCE") {
          const output = asString(responseEnvelope.payload.output)
            || String(Date.now() - startedAt);
          return { ok: true, output };
        }
      }

      const text = extractAnyText(result.response);
      return {
        ok: true,
        output: text || String(Date.now() - startedAt),
      };
    } catch (error: unknown) {
      this.markPeerFailure(peer.name);
      return {
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private rememberPeerMapping(peerName: string, nodeId: string): void {
    if (!peerName || !nodeId) return;
    this.nodeIdToPeerName.set(nodeId, peerName);
    this.peerNameToNodeId.set(peerName, nodeId);
    const current = this.neighbors.get(nodeId);
    if (current) {
      this.neighbors.updatePeerName(nodeId, peerName);
      return;
    }
    this.neighbors.upsertOnline({
      nodeId,
      runtimeType: "openclaw",
      skills: [],
      peerName,
    });
  }

  private getEligibleNodes(): MeshNeighborNode[] {
    const localNode: MeshNeighborNode = {
      nodeId: this.config.nodeId,
      runtimeType: this.config.runtimeType,
      skills: [...this.localSkills],
      status: "online",
      lastSeenAt: Date.now(),
      missCount: 0,
      latencyMs: 1,
      peerName: null,
      costHint: average(this.localCapabilities.map((c) => c.costHint), 1),
      latencyHint: average(this.localCapabilities.map((c) => c.latencyHint), 1),
    };

    return [localNode, ...this.neighbors.listOnline()];
  }

  private ensureLocalIncluded(nodes: MeshNeighborNode[]): MeshNeighborNode[] {
    if (nodes.some((n) => n.nodeId === this.config.nodeId)) {
      return nodes;
    }
    return [
      {
        nodeId: this.config.nodeId,
        runtimeType: this.config.runtimeType,
        skills: [...this.localSkills],
        status: "online",
        lastSeenAt: Date.now(),
        missCount: 0,
        latencyMs: 1,
        peerName: null,
        costHint: average(this.localCapabilities.map((c) => c.costHint), 1),
        latencyHint: average(this.localCapabilities.map((c) => c.latencyHint), 1),
      },
      ...nodes,
    ];
  }
}

function createStages(template: MeshTemplate, topology: MeshTopology, nodeIds: string[], localNodeId: string) {
  const remoteNodes = nodeIds.filter((id) => id !== localNodeId);
  const firstRemote = remoteNodes[0] || localNodeId;
  const secondRemote = remoteNodes[1] || firstRemote;

  if (template === "analyze") {
    return [
      stage("stage-1", "decompose", [localNodeId]),
      stage("stage-2", "parallel-analyze", topology === "serial" ? [firstRemote] : remoteNodes.length ? remoteNodes : [localNodeId]),
      stage("stage-3", "merge", [localNodeId]),
    ];
  }

  if (template === "build") {
    return [
      stage("stage-1", "plan", [localNodeId]),
      stage("stage-2", "execute", [firstRemote]),
      stage("stage-3", "verify", [secondRemote]),
      stage("stage-4", "merge", [localNodeId]),
    ];
  }

  return [
    stage("stage-1", "parallel-review", nodeIds.length ? nodeIds : [localNodeId]),
    stage("stage-2", "cross-review", topology === "full-mesh" ? (nodeIds.length ? nodeIds : [localNodeId]) : [localNodeId]),
    stage("stage-3", "conclude", [localNodeId]),
  ];
}

function stage(stageId: string, name: string, assignedNodeIds: string[]) {
  return {
    stageId,
    name,
    status: "pending" as const,
    assignedNodeIds: [...new Set(assignedNodeIds)],
    attempts: 0,
    results: [] as Array<{ nodeId: string; ok: boolean; output: string }>,
  };
}

function mergeStageResults(task: MeshTaskRecord): string {
  const chunks = task.stages.map((s) => {
    const lines = s.results.map((r) => `${r.ok ? "OK" : "FAIL"} ${r.nodeId}: ${truncate(r.output, 280)}`);
    return `## ${s.name}\n${lines.join("\n")}`;
  });
  return [
    `Mesh task ${task.meshTaskId}`,
    `Template: ${task.template}`,
    `Topology: ${task.selectedTopology}`,
    `Nodes: ${task.selectedNodes.join(", ")}`,
    "",
    ...chunks,
  ].join("\n");
}

function extractMeshEnvelope(value: unknown): MeshControlEnvelope | null {
  return findEnvelopeRecursive(value, 0);
}

function findEnvelopeRecursive(value: unknown, depth: number): MeshControlEnvelope | null {
  if (depth > 10 || value === null || value === undefined) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return parseEnvelopeCandidate(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findEnvelopeRecursive(entry, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  if (value.kind === "data" && value.mimeType === MESH_CONTROL_MIME) {
    return parseEnvelopeCandidate(value.data);
  }

  const parts = Array.isArray(value.parts) ? value.parts : [];
  for (const part of parts) {
    const hit = findEnvelopeRecursive(part, depth + 1);
    if (hit) return hit;
  }

  for (const nested of Object.values(value)) {
    const hit = findEnvelopeRecursive(nested, depth + 1);
    if (hit) return hit;
  }

  return null;
}

function parseEnvelopeCandidate(value: unknown): MeshControlEnvelope | null {
  if (!isRecord(value)) return null;
  if (value.meshProtocolVersion !== MESH_PROTOCOL_VERSION) return null;
  if (typeof value.type !== "string") return null;
  if (typeof value.fromNodeId !== "string" || !value.fromNodeId.trim()) return null;
  if (typeof value.timestamp !== "string") return null;
  if (!isRecord(value.payload)) return null;

  return {
    meshProtocolVersion: MESH_PROTOCOL_VERSION,
    type: value.type as MeshControlEnvelope["type"],
    ...(typeof value.meshTaskId === "string" && value.meshTaskId ? { meshTaskId: value.meshTaskId } : {}),
    fromNodeId: value.fromNodeId,
    ...(typeof value.toNodeId === "string" && value.toNodeId ? { toNodeId: value.toNodeId } : {}),
    timestamp: value.timestamp,
    payload: value.payload as Record<string, unknown>,
  };
}

function extractAnyText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractAnyText(item);
      if (nested) return nested;
    }
    return "";
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string" && value.text.trim()) return value.text;
  const parts = Array.isArray(value.parts) ? value.parts : [];
  for (const part of parts) {
    if (isRecord(part) && part.kind === "text" && typeof part.text === "string" && part.text.trim()) {
      return part.text;
    }
  }
  for (const nested of Object.values(value)) {
    const text = extractAnyText(nested);
    if (text) return text;
  }
  return "";
}

function normalizeRuntimeType(value: string): "openclaw" | "ollama-adapter" {
  return value === "ollama-adapter" ? "ollama-adapter" : "openclaw";
}

function normalizeCapabilities(raw: unknown[], runtimeType: "openclaw" | "ollama-adapter"): MeshCapability[] {
  if (!Array.isArray(raw)) return [];
  const result: MeshCapability[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const skillId = asString(entry.skillId).trim();
    if (!skillId) continue;
    result.push({
      skillId,
      tags: normalizeStringArray(entry.tags as unknown[]),
      runtimeType: normalizeRuntimeType(asString(entry.runtimeType) || runtimeType),
      costHint: clampNumber(asNumber(entry.costHint), 1, 0.1, 10),
      latencyHint: clampNumber(asNumber(entry.latencyHint), 1, 0.1, 10_000),
    });
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || result.includes(trimmed)) continue;
    result.push(trimmed);
  }
  return result;
}

function extractError(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (typeof value.error === "string") return value.error;
  for (const nested of Object.values(value)) {
    const msg = extractError(nested);
    if (msg) return msg;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function average(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return fallback;
  return Number((finite.reduce((acc, n) => acc + n, 0) / finite.length).toFixed(3));
}

function clampNumber(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, Math.min(max, value));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}
