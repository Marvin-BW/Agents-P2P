import type { Part } from "@a2a-js/sdk";

import type { PeerConfig } from "./types.js";

export const MESH_PROTOCOL_VERSION = "0.1" as const;
export const MESH_CONTROL_MIME = "application/vnd.a2a.mesh+json";

export type MeshRuntimeType = "openclaw" | "ollama-adapter";
export type MeshNeighborStatus = "online" | "suspect" | "offline";
export type MeshTopology = "serial" | "star" | "full-mesh";
export type MeshTemplate = "analyze" | "build" | "review";
export type MeshTemplateOrAuto = MeshTemplate | "auto";
export type MeshTaskState = "RECEIVED" | "PLANNED" | "DISPATCHING" | "COLLECTING" | "MERGING" | "DONE" | "FAILED";

export type MeshControlType =
  | "ANNOUNCE"
  | "PING"
  | "PONG"
  | "TASK_OFFER"
  | "TASK_ACCEPT"
  | "TASK_RESULT"
  | "TASK_FAIL"
  | "DELEGATE_TO_COORDINATOR";

export interface MeshCapability {
  skillId: string;
  tags: string[];
  runtimeType: MeshRuntimeType;
  costHint: number;
  latencyHint: number;
}

export interface MeshHeartbeatConfig {
  intervalMs: number;
  suspectThreshold: number;
  offlineThreshold: number;
}

export interface MeshSchedulerConfig {
  maxFanout: number;
  fullMeshMaxNodes: number;
}

export interface MeshConfig {
  enabled: boolean;
  nodeId: string;
  runtimeType: MeshRuntimeType;
  seedPeers: PeerConfig[];
  coordinator: {
    fallbackNodeId: string;
  };
  heartbeat: MeshHeartbeatConfig;
  scheduler: MeshSchedulerConfig;
  capabilities: MeshCapability[];
}

export interface MeshControlEnvelope {
  meshProtocolVersion: typeof MESH_PROTOCOL_VERSION;
  type: MeshControlType;
  meshTaskId?: string;
  fromNodeId: string;
  toNodeId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface MeshNeighborNode {
  nodeId: string;
  runtimeType: MeshRuntimeType;
  skills: string[];
  status: MeshNeighborStatus;
  lastSeenAt: number | null;
  missCount: number;
  latencyMs: number | null;
  peerName: string | null;
  costHint: number;
  latencyHint: number;
}

export type MeshStageStatus = "pending" | "dispatching" | "collecting" | "done" | "failed";

export interface MeshStageRecord {
  stageId: string;
  name: string;
  status: MeshStageStatus;
  assignedNodeIds: string[];
  attempts: number;
  results: Array<{
    nodeId: string;
    ok: boolean;
    output: string;
  }>;
}

export interface MeshTaskRecord {
  meshTaskId: string;
  goal: string;
  requiredSkills: string[];
  template: MeshTemplate;
  selectedTopology: MeshTopology;
  selectedNodes: string[];
  state: MeshTaskState;
  stages: MeshStageRecord[];
  createdAt: string;
  updatedAt: string;
  finalResult?: string;
  error?: string;
}

export interface MeshTaskSubmitInput {
  goal: string;
  requiredSkills?: string[];
  template?: MeshTemplateOrAuto;
}

export interface MeshTaskSubmitResult {
  meshTaskId: string;
  selectedTopology: MeshTopology;
  selectedNodes: string[];
  state: MeshTaskState;
}

export interface MeshControlHandleResult {
  handled: boolean;
  responseParts?: Part[];
}

export interface MeshControlPlane {
  start(): Promise<void>;
  stop(): void;
  isStarted(): boolean;
  getNodeStatus(): Record<string, unknown>;
  listNeighbors(): MeshNeighborNode[];
  listTasks(): MeshTaskRecord[];
  getTask(meshTaskId: string): MeshTaskRecord | undefined;
  submitTask(input: MeshTaskSubmitInput): Promise<MeshTaskSubmitResult>;
  handleInboundControlMessage(message: unknown): Promise<MeshControlHandleResult>;
}
