#!/usr/bin/env node

import crypto from "node:crypto";
import os from "node:os";

import express from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";

const MESH_PROTOCOL_VERSION = "0.1";
const MESH_CONTROL_MIME = "application/vnd.a2a.mesh+json";

const HOST = process.env.ADAPTER_HOST || "0.0.0.0";
const PORT = Number(process.env.ADAPTER_PORT || 18900);
const ADAPTER_PUBLIC_BASE_URL = process.env.ADAPTER_PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
const CARD_PATH = AGENT_CARD_PATH.startsWith("/") ? AGENT_CARD_PATH : `/${AGENT_CARD_PATH}`;
const ADAPTER_AGENT_CARD_URL = `${ADAPTER_PUBLIC_BASE_URL}${CARD_PATH}`;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const NODE_ID = process.env.MESH_NODE_ID || `ollama-${os.hostname() || "node"}`;
const COORDINATOR_AGENT_CARD_URL = String(process.env.MESH_COORDINATOR_AGENT_CARD_URL || "").trim();
const COORDINATOR_TOKEN = String(process.env.MESH_COORDINATOR_TOKEN || process.env.MESH_TOKEN || "").trim();
const SEED_PEERS_RAW = String(process.env.MESH_SEED_PEERS || "").trim();
const SKILLS = String(process.env.OLLAMA_SKILLS || "chat,analysis,build,review")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function asObject(value) {
  return value && typeof value === "object" ? value : null;
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = extractText(item);
      if (hit) return hit;
    }
    return "";
  }
  const obj = asObject(value);
  if (!obj) return "";
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  if (Array.isArray(obj.parts)) {
    for (const part of obj.parts) {
      if (part && typeof part === "object" && part.kind === "text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  for (const nested of Object.values(obj)) {
    const hit = extractText(nested);
    if (hit) return hit;
  }
  return "";
}

function extractMeshEnvelope(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = extractMeshEnvelope(item);
      if (hit) return hit;
    }
    return null;
  }
  const obj = asObject(value);
  if (!obj) return null;
  if (obj.kind === "data" && obj.mimeType === MESH_CONTROL_MIME && asObject(obj.data)) {
    const data = obj.data;
    if (data.meshProtocolVersion === MESH_PROTOCOL_VERSION && typeof data.type === "string" && typeof data.fromNodeId === "string") {
      return data;
    }
  }
  if (Array.isArray(obj.parts)) {
    for (const part of obj.parts) {
      const hit = extractMeshEnvelope(part);
      if (hit) return hit;
    }
  }
  for (const nested of Object.values(obj)) {
    const hit = extractMeshEnvelope(nested);
    if (hit) return hit;
  }
  return null;
}

function createFrame(type, fromNodeId, payload = {}, meshTaskId, toNodeId) {
  return {
    meshProtocolVersion: MESH_PROTOCOL_VERSION,
    type,
    ...(meshTaskId ? { meshTaskId } : {}),
    fromNodeId,
    ...(toNodeId ? { toNodeId } : {}),
    timestamp: new Date().toISOString(),
    payload,
  };
}

function parsePeerAuth(value) {
  const obj = asObject(value);
  if (!obj) return undefined;
  const type = String(obj.type || "").trim();
  const token = String(obj.token || "").trim();
  if (!token) return undefined;
  if (type !== "bearer" && type !== "apiKey") return undefined;
  return { type, token };
}

function parseSeedPeers(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const parsed = [];
  const pushPeer = (candidate) => {
    if (!candidate) return;
    if (typeof candidate === "string") {
      const agentCardUrl = candidate.trim();
      if (agentCardUrl) parsed.push({ agentCardUrl });
      return;
    }
    const obj = asObject(candidate);
    if (!obj) return;
    const agentCardUrl = String(obj.agentCardUrl || obj.url || "").trim();
    if (!agentCardUrl) return;
    const auth = parsePeerAuth(obj.auth);
    const token = String(obj.token || "").trim();
    if (auth) {
      parsed.push({ agentCardUrl, auth });
      return;
    }
    if (token) {
      parsed.push({ agentCardUrl, auth: { type: "bearer", token } });
      return;
    }
    parsed.push({ agentCardUrl });
  };

  if (trimmed.startsWith("[")) {
    try {
      const array = JSON.parse(trimmed);
      if (Array.isArray(array)) {
        for (const item of array) {
          pushPeer(item);
        }
      }
    } catch {
      // ignore parse errors and fallback to comma-separated format
    }
  }

  if (parsed.length === 0) {
    for (const part of trimmed.split(",")) {
      pushPeer(part);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const peer of parsed) {
    if (seen.has(peer.agentCardUrl)) continue;
    seen.add(peer.agentCardUrl);
    deduped.push(peer);
  }
  return deduped;
}

function resolveBootstrapPeers() {
  const peers = parseSeedPeers(SEED_PEERS_RAW);
  if (COORDINATOR_AGENT_CARD_URL) {
    peers.unshift({
      agentCardUrl: COORDINATOR_AGENT_CARD_URL,
      ...(COORDINATOR_TOKEN ? { auth: { type: "bearer", token: COORDINATOR_TOKEN } } : {}),
    });
  }
  const seen = new Set();
  return peers.filter((peer) => {
    if (!peer.agentCardUrl || seen.has(peer.agentCardUrl)) return false;
    seen.add(peer.agentCardUrl);
    return true;
  });
}

function buildAuthHeaders(auth) {
  if (!auth || !auth.token) return {};
  if (auth.type === "apiKey") return { "x-api-key": auth.token };
  return { authorization: `Bearer ${auth.token}` };
}

function buildAnnouncePayload() {
  return {
    runtimeType: "ollama-adapter",
    skills: SKILLS,
    agentCardUrl: ADAPTER_AGENT_CARD_URL,
    capabilities: SKILLS.map((skill, idx) => ({
      skillId: skill,
      tags: [],
      runtimeType: "ollama-adapter",
      costHint: 1 + idx * 0.01,
      latencyHint: 1.2,
    })),
  };
}

function resolveJsonRpcUrlFromCard(card, fallbackAgentCardUrl) {
  const cardObj = asObject(card) || {};
  const directUrl = String(cardObj.url || "").trim();
  if (directUrl) return directUrl;
  const interfaces = Array.isArray(cardObj.additionalInterfaces) ? cardObj.additionalInterfaces : [];
  for (const item of interfaces) {
    const iface = asObject(item);
    if (!iface) continue;
    const transport = String(iface.transport || "").toUpperCase();
    const url = String(iface.url || "").trim();
    if (url && transport.includes("JSONRPC")) return url;
  }
  try {
    return `${new URL(fallbackAgentCardUrl).origin}/a2a/jsonrpc`;
  } catch {
    return "";
  }
}

async function announceToPeer(peer) {
  const authHeaders = buildAuthHeaders(peer.auth);
  const cardRes = await fetch(peer.agentCardUrl, { headers: authHeaders });
  if (!cardRes.ok) {
    throw new Error(`fetch card failed ${cardRes.status}`);
  }
  const card = await cardRes.json();
  const rpcUrl = resolveJsonRpcUrlFromCard(card, peer.agentCardUrl);
  if (!rpcUrl) {
    throw new Error("unable to resolve peer JSON-RPC url");
  }

  const announce = createFrame("ANNOUNCE", NODE_ID, buildAnnouncePayload());
  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "data", mimeType: MESH_CONTROL_MIME, data: announce }],
      },
    },
  };

  const sendRes = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!sendRes.ok) {
    const text = await sendRes.text();
    throw new Error(`announce failed ${sendRes.status}: ${text}`);
  }
}

async function bootstrapAnnounce() {
  const peers = resolveBootstrapPeers();
  if (peers.length === 0) return;
  for (const peer of peers) {
    try {
      await announceToPeer(peer);
      console.log(`[mesh] announce sent -> ${peer.agentCardUrl}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[mesh] announce failed -> ${peer.agentCardUrl}: ${reason}`);
    }
  }
}

async function runOllama(prompt) {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return typeof data.response === "string" ? data.response : JSON.stringify(data);
}

class OllamaExecutor {
  async execute(requestContext, eventBus) {
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const history = requestContext.task?.history || [];

    const envelope = extractMeshEnvelope(requestContext.userMessage);
    if (envelope) {
      const payload = asObject(envelope.payload) || {};
      if (envelope.type === "PING") {
        const pong = createFrame("PONG", NODE_ID, {
          pingId: payload.pingId || "",
          sentAt: payload.sentAt || Date.now(),
          receivedAt: Date.now(),
          runtimeType: "ollama-adapter",
        }, envelope.meshTaskId, envelope.fromNodeId);
        this.reply(taskId, contextId, history, eventBus, [{ kind: "data", mimeType: MESH_CONTROL_MIME, data: pong }]);
        return;
      }
      if (envelope.type === "ANNOUNCE") {
        const announce = createFrame("ANNOUNCE", NODE_ID, buildAnnouncePayload(), envelope.meshTaskId, envelope.fromNodeId);
        this.reply(taskId, contextId, history, eventBus, [{ kind: "data", mimeType: MESH_CONTROL_MIME, data: announce }]);
        return;
      }
      if (envelope.type === "TASK_OFFER" || envelope.type === "DELEGATE_TO_COORDINATOR") {
        const goal = String(payload.goal || payload.message || "No goal");
        const stage = String(payload.stageName || "mesh-stage");
        const prompt = `[Mesh Task]\nNode: ${NODE_ID}\nStage: ${stage}\nGoal: ${goal}\nPlease provide concise execution output.`;
        try {
          const output = await runOllama(prompt);
          const frame = createFrame("TASK_RESULT", NODE_ID, { stageName: stage, output }, envelope.meshTaskId, envelope.fromNodeId);
          this.reply(taskId, contextId, history, eventBus, [{ kind: "data", mimeType: MESH_CONTROL_MIME, data: frame }]);
        } catch (error) {
          const frame = createFrame("TASK_FAIL", NODE_ID, {
            reason: error instanceof Error ? error.message : String(error),
          }, envelope.meshTaskId, envelope.fromNodeId);
          this.reply(taskId, contextId, history, eventBus, [{ kind: "data", mimeType: MESH_CONTROL_MIME, data: frame }]);
        }
        return;
      }

      const ack = createFrame("TASK_ACCEPT", NODE_ID, { ackFor: envelope.type }, envelope.meshTaskId, envelope.fromNodeId);
      this.reply(taskId, contextId, history, eventBus, [{ kind: "data", mimeType: MESH_CONTROL_MIME, data: ack }]);
      return;
    }

    const prompt = extractText(requestContext.userMessage) || "Hello";
    try {
      const output = await runOllama(prompt);
      this.reply(taskId, contextId, history, eventBus, [{ kind: "text", text: output }]);
    } catch (error) {
      this.reply(taskId, contextId, history, eventBus, [{
        kind: "text",
        text: `Ollama adapter error: ${error instanceof Error ? error.message : String(error)}`,
      }], "failed");
    }
  }

  async cancelTask(_taskId, eventBus) {
    eventBus.finished();
  }

  reply(taskId, contextId, history, eventBus, parts, state = "completed") {
    const message = {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      parts,
      contextId,
    };
    const task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state,
        message,
        timestamp: new Date().toISOString(),
      },
      history,
      artifacts: [{ artifactId: crypto.randomUUID(), parts }],
    };
    eventBus.publish(task);
    eventBus.finished();
  }
}

const agentCard = {
  protocolVersion: "0.3.0",
  version: "0.1.0",
  name: `Ollama Adapter (${NODE_ID})`,
  description: "A2A adapter for local Ollama with mesh control-frame support",
  url: `${ADAPTER_PUBLIC_BASE_URL}/a2a/jsonrpc`,
  skills: SKILLS.map((skill, idx) => ({
    id: `${skill}-${idx + 1}`,
    name: skill,
    description: `${skill} via Ollama`,
    tags: [],
  })),
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  securitySchemes: {},
  security: [],
  supportsAuthenticatedExtendedCard: false,
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  additionalInterfaces: [
    { url: `${ADAPTER_PUBLIC_BASE_URL}/a2a/jsonrpc`, transport: "JSONRPC" },
    { url: `${ADAPTER_PUBLIC_BASE_URL}/a2a/rest`, transport: "HTTP+JSON" },
  ],
};

const handler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new OllamaExecutor());
const app = express();

app.use(CARD_PATH, agentCardHandler({ agentCardProvider: handler }));
if (CARD_PATH !== "/.well-known/agent.json") {
  app.use("/.well-known/agent.json", agentCardHandler({ agentCardProvider: handler }));
}
app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler: handler, userBuilder: async () => UserBuilder.noAuthentication() }));
app.use("/a2a/rest", restHandler({ requestHandler: handler, userBuilder: async () => UserBuilder.noAuthentication() }));

const server = app.listen(PORT, HOST, () => {
  console.log(`ollama-a2a-adapter listening on ${HOST}:${PORT}`);
  console.log(`public_base=${ADAPTER_PUBLIC_BASE_URL} ollama=${OLLAMA_BASE_URL} model=${OLLAMA_MODEL} node=${NODE_ID}`);
  void bootstrapAnnounce();
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
