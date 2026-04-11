/**
 * A2A Gateway plugin endpoints:
 * - /.well-known/agent.json  (Agent Card discovery)
 * - /a2a/jsonrpc              (JSON-RPC transport)
 * - /a2a/rest                 (REST transport)
 * - gRPC on port+1            (gRPC transport)
 */

import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";
import { grpcService, A2AService, UserBuilder as GrpcUserBuilder } from "@a2a-js/sdk/server/grpc";
import { Server as GrpcServer, ServerCredentials, status as GrpcStatus } from "@grpc/grpc-js";
import express from "express";

import { buildAgentCard } from "./src/agent-card.js";
import { A2AClient } from "./src/client.js";
import {
  DnsDiscoveryManager,
  mergeWithStaticPeers,
  parseDnsDiscoveryConfig,
} from "./src/dns-discovery.js";
import {
  MdnsResponder,
  buildMdnsAdvertiseConfig,
} from "./src/dns-responder.js";
import { OpenClawAgentExecutor } from "./src/executor.js";
import { QueueingAgentExecutor } from "./src/queueing-executor.js";
import { runTaskCleanup } from "./src/task-cleanup.js";
import { FileTaskStore } from "./src/task-store.js";
import { GatewayTelemetry } from "./src/telemetry.js";
import { AuditLogger } from "./src/audit.js";
import { PeerHealthManager } from "./src/peer-health.js";
import { PushNotificationStore } from "./src/push-notifications.js";
import { MeshNetworkManager } from "./src/mesh-control.js";
import { renderMeshDashboardHtml } from "./src/mesh-dashboard.js";
import type {
  AgentCardConfig,
  GatewayConfig,
  InboundAuth,
  OpenClawPluginApi,
  PeerConfig,
} from "./src/types.js";
import {
  validateUri,
  validateMimeType,
} from "./src/file-security.js";
import { parseRoutingRules, matchRule } from "./src/routing-rules.js";
import type { MeshCapability, MeshRuntimeType } from "./src/mesh-types.js";

/** Build a JSON-RPC error response. */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeHttpPath(value: string, fallback: string): string {
  const trimmed = value.trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveConfiguredPath(
  value: unknown,
  fallback: string,
  resolvePath?: (nextPath: string) => string,
): string {
  const rawConfigured = asString(value, "").trim();
  const configured = rawConfigured || fallback;
  const resolved = resolvePath ? resolvePath(configured) : configured;
  if (path.isAbsolute(resolved)) {
    return resolved;
  }

  const absolute = path.resolve(resolved);

  // Backward-compat: when users provide a relative path using POSIX separators
  // (e.g. "data/tasks"), keep "/" in the final absolute path string on Windows.
  // Existing defaults remain platform-native because rawConfigured is empty.
  if (path.sep === "\\" && rawConfigured.includes("/") && !rawConfigured.includes("\\")) {
    return absolute.replace(/\\/g, "/");
  }

  return absolute;
}

function parseAgentCard(raw: Record<string, unknown>): AgentCardConfig {
  const skills = Array.isArray(raw.skills) ? raw.skills : [];

  return {
    name: asString(raw.name, "OpenClaw A2A Gateway"),
    description: asString(raw.description, "A2A bridge for OpenClaw agents"),
    url: asString(raw.url, ""),
    skills: skills.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const skill = asObject(entry);
      return {
        id: asString(skill.id, ""),
        name: asString(skill.name, "unknown"),
        description: asString(skill.description, ""),
      };
    }),
  };
}

function parsePeers(raw: unknown): PeerConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const peers: PeerConfig[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const name = asString(value.name, "");
    const agentCardUrl = asString(value.agentCardUrl, "");
    if (!name || !agentCardUrl) {
      continue;
    }

    const authRaw = asObject(value.auth);
    const authTypeRaw = asString(authRaw.type, "");
    const authType = authTypeRaw === "bearer" || authTypeRaw === "apiKey" ? authTypeRaw : "";
    const token = asString(authRaw.token, "");

    peers.push({
      name,
      agentCardUrl,
      auth: authType && token ? { type: authType, token } : undefined,
    });
  }

  return peers;
}

function dedupePeersByName(peers: PeerConfig[]): PeerConfig[] {
  const byName = new Map<string, PeerConfig>();
  for (const peer of peers) {
    if (!peer.name || !peer.agentCardUrl) continue;
    byName.set(peer.name, peer);
  }
  return [...byName.values()];
}

function parsePeerRegistryPayload(raw: unknown): { peers: PeerConfig[]; seedPeers: PeerConfig[] } {
  if (Array.isArray(raw)) {
    const peers = dedupePeersByName(parsePeers(raw));
    return { peers, seedPeers: peers };
  }

  const value = asObject(raw);
  const peersRaw = Array.isArray(value.peers)
    ? value.peers
    : Array.isArray(value.nodes)
      ? value.nodes
      : [];
  const seedPeersRaw = Array.isArray(value.seedPeers)
    ? value.seedPeers
    : Array.isArray(value.meshSeedPeers)
      ? value.meshSeedPeers
      : undefined;

  const peers = dedupePeersByName(parsePeers(peersRaw));
  const seedPeers = seedPeersRaw !== undefined
    ? dedupePeersByName(parsePeers(seedPeersRaw))
    : peers;

  if (peers.length === 0 && seedPeers.length === 0) {
    throw new Error("peer registry file is empty or invalid");
  }

  return { peers, seedPeers };
}

function parseMeshRuntimeType(raw: unknown): MeshRuntimeType {
  return raw === "ollama-adapter" ? "ollama-adapter" : "openclaw";
}

function parseMeshCapabilities(
  raw: unknown,
  fallbackSkills: AgentCardConfig["skills"],
  runtimeType: MeshRuntimeType,
): MeshCapability[] {
  const capabilities: MeshCapability[] = [];
  const source = Array.isArray(raw) ? raw : [];

  for (const entry of source) {
    const value = asObject(entry);
    const skillId = asString(value.skillId, "").trim();
    if (!skillId) continue;
    const tags = Array.isArray(value.tags)
      ? value.tags.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      : [];
    capabilities.push({
      skillId,
      tags,
      runtimeType: typeof value.runtimeType === "string" ? parseMeshRuntimeType(value.runtimeType) : runtimeType,
      costHint: Math.max(0.1, asNumber(value.costHint, 1)),
      latencyHint: Math.max(0.1, asNumber(value.latencyHint, 1)),
    });
  }

  if (capabilities.length > 0) {
    return capabilities;
  }

  let index = 0;
  for (const skill of fallbackSkills) {
    if (typeof skill === "string") {
      const name = skill.trim();
      if (!name) continue;
      capabilities.push({
        skillId: name,
        tags: [],
        runtimeType,
        costHint: 1 + index * 0.01,
        latencyHint: 1,
      });
      index += 1;
      continue;
    }

    const name = asString(asObject(skill).id, "").trim() || asString(asObject(skill).name, "").trim();
    if (!name) continue;
    capabilities.push({
      skillId: name,
      tags: [],
      runtimeType,
      costHint: 1 + index * 0.01,
      latencyHint: 1,
    });
    index += 1;
  }

  return capabilities;
}

export function parseConfig(raw: unknown, resolvePath?: (nextPath: string) => string): GatewayConfig {
  const config = asObject(raw);
  const server = asObject(config.server);
  const storage = asObject(config.storage);
  const security = asObject(config.security);
  const routing = asObject(config.routing);
  const limits = asObject(config.limits);
  const observability = asObject(config.observability);
  const timeouts = asObject(config.timeouts);
  const resilience = asObject(config.resilience);
  const mesh = asObject(config.mesh);
  const healthCheck = asObject(resilience.healthCheck);
  const retry = asObject(resilience.retry);
  const circuitBreaker = asObject(resilience.circuitBreaker);
  const discoveryRaw = config.discovery ? asObject(config.discovery) : undefined;
  const peerRegistryRaw = config.peerRegistry ? asObject(config.peerRegistry) : {};

  const inboundAuth = asString(security.inboundAuth, "none") as InboundAuth;

  const defaultMimeTypes = [
    "image/*", "application/pdf", "text/plain", "text/csv",
    "application/json", "audio/*", "video/*",
  ];
  const rawAllowedMime = Array.isArray(security.allowedMimeTypes) ? security.allowedMimeTypes : [];
  const allowedMimeTypes = rawAllowedMime.length > 0
    ? rawAllowedMime.filter((v: unknown) => typeof v === "string") as string[]
    : defaultMimeTypes;
  const rawUriAllowlist = Array.isArray(security.fileUriAllowlist) ? security.fileUriAllowlist : [];
  const fileUriAllowlist = rawUriAllowlist.filter((v: unknown) => typeof v === "string") as string[];
  const parsedAgentCard = parseAgentCard(asObject(config.agentCard));
  const meshRuntimeType = parseMeshRuntimeType(mesh.runtimeType);
  const meshSeedPeers = parsePeers(mesh.seedPeers);
  const meshCapabilities = parseMeshCapabilities(mesh.capabilities, parsedAgentCard.skills, meshRuntimeType);
  const peerRegistryFilePathRaw = asString(peerRegistryRaw.filePath || config.peerRegistryFile, "").trim();
  const peerRegistryFilePath = peerRegistryFilePathRaw
    ? resolveConfiguredPath(peerRegistryFilePathRaw, peerRegistryFilePathRaw, resolvePath)
    : "";
  const peerRegistryPollIntervalMs = Math.max(1000, asNumber(peerRegistryRaw.pollIntervalMs, 5000));

  return {
    agentCard: parsedAgentCard,
    server: {
      host: asString(server.host, "0.0.0.0"),
      port: asNumber(server.port, 18800),
    },
    storage: {
      tasksDir: resolveConfiguredPath(
        storage.tasksDir,
        path.join(os.homedir(), ".openclaw", "a2a-tasks"),
        resolvePath,
      ),
      taskTtlHours: Math.max(1, asNumber(storage.taskTtlHours, 72)),
      cleanupIntervalMinutes: Math.max(1, asNumber(storage.cleanupIntervalMinutes, 60)),
    },
    peers: parsePeers(config.peers),
    peerRegistry: peerRegistryFilePath
      ? {
          filePath: peerRegistryFilePath,
          pollIntervalMs: peerRegistryPollIntervalMs,
        }
      : undefined,
    security: (() => {
      const singleToken = asString(security.token, "");
      const tokenArray = Array.isArray(security.tokens)
        ? (security.tokens as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0)
        : [];
      const validTokens = new Set<string>(
        [singleToken, ...tokenArray].filter(t => t.length > 0),
      );
      return {
        inboundAuth: inboundAuth === "bearer" ? "bearer" : "none" as const,
        token: singleToken,
        tokens: tokenArray,
        validTokens,
        allowedMimeTypes,
        maxFileSizeBytes: asNumber(security.maxFileSizeBytes, 52_428_800),
        maxInlineFileSizeBytes: asNumber(security.maxInlineFileSizeBytes, 10_485_760),
        fileUriAllowlist,
      };
    })(),
    routing: {
      defaultAgentId: asString(routing.defaultAgentId, "default"),
      rules: parseRoutingRules(routing.rules),
    },
    limits: {
      maxConcurrentTasks: Math.max(1, Math.floor(asNumber(limits.maxConcurrentTasks, 4))),
      maxQueuedTasks: Math.max(0, Math.floor(asNumber(limits.maxQueuedTasks, 100))),
    },
    observability: {
      structuredLogs: asBoolean(observability.structuredLogs, true),
      exposeMetricsEndpoint: asBoolean(observability.exposeMetricsEndpoint, true),
      metricsPath: normalizeHttpPath(asString(observability.metricsPath, "/a2a/metrics"), "/a2a/metrics"),
      metricsAuth: (asString(observability.metricsAuth, "none") === "bearer" ? "bearer" : "none") as "none" | "bearer",
      auditLogPath: resolveConfiguredPath(
        observability.auditLogPath,
        path.join(os.homedir(), ".openclaw", "a2a-audit.jsonl"),
        resolvePath,
      ),
    },
    timeouts: {
      agentResponseTimeoutMs: asNumber(timeouts.agentResponseTimeoutMs, 300_000),
    },
    resilience: {
      healthCheck: {
        enabled: asBoolean(healthCheck.enabled, true),
        intervalMs: asNumber(healthCheck.intervalMs, 30_000),
        timeoutMs: asNumber(healthCheck.timeoutMs, 5_000),
      },
      retry: {
        maxRetries: Math.max(0, Math.floor(asNumber(retry.maxRetries, 3))),
        baseDelayMs: asNumber(retry.baseDelayMs, 1_000),
        maxDelayMs: asNumber(retry.maxDelayMs, 10_000),
      },
      circuitBreaker: {
        failureThreshold: Math.max(1, Math.floor(asNumber(circuitBreaker.failureThreshold, 5))),
        resetTimeoutMs: asNumber(circuitBreaker.resetTimeoutMs, 30_000),
      },
    },
    discovery: parseDnsDiscoveryConfig(discoveryRaw),
    advertise: buildMdnsAdvertiseConfig({
      agentCardName: asString(asObject(config.agentCard).name, "OpenClaw A2A Gateway"),
      serverHost: asString(asObject(config.server).host, "0.0.0.0"),
      serverPort: asNumber(asObject(config.server).port, 18800),
      inboundAuth: asString(asObject(config.security).inboundAuth, "none"),
      token: asString(asObject(config.security).token, "") || undefined,
      raw: config.advertise ? asObject(config.advertise) : undefined,
    }),
    mesh: {
      enabled: asBoolean(mesh.enabled, false),
      nodeId: asString(mesh.nodeId, `node-${os.hostname() || "local"}`).trim() || `node-${os.hostname() || "local"}`,
      runtimeType: meshRuntimeType,
      seedPeers: meshSeedPeers,
      coordinator: {
        fallbackNodeId: asString(asObject(mesh.coordinator).fallbackNodeId, "").trim(),
      },
      heartbeat: {
        intervalMs: Math.max(1000, asNumber(asObject(mesh.heartbeat).intervalMs, 5000)),
        suspectThreshold: Math.max(1, Math.floor(asNumber(asObject(mesh.heartbeat).suspectThreshold, 3))),
        offlineThreshold: Math.max(1, Math.floor(asNumber(asObject(mesh.heartbeat).offlineThreshold, 5))),
      },
      scheduler: {
        maxFanout: Math.max(1, Math.floor(asNumber(asObject(mesh.scheduler).maxFanout, 4))),
        fullMeshMaxNodes: Math.max(2, Math.floor(asNumber(asObject(mesh.scheduler).fullMeshMaxNodes, 6))),
      },
      capabilities: meshCapabilities,
    },
  };
}

function normalizeCardPath(): string {
  if (AGENT_CARD_PATH.startsWith("/")) {
    return AGENT_CARD_PATH;
  }

  return `/${AGENT_CARD_PATH}`;
}

const plugin = {
  id: "a2a-gateway",
  name: "A2A Gateway",
  description: "OpenClaw plugin that serves A2A v0.3.0 endpoints",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig, api.resolvePath?.bind(api));

    const applyPeerRegistrySnapshot = (snapshot: { peers: PeerConfig[]; seedPeers: PeerConfig[] }, source: string) => {
      config.peers = dedupePeersByName(snapshot.peers);
      config.mesh.seedPeers = dedupePeersByName(snapshot.seedPeers);
      api.logger.info(`a2a-gateway: peer registry applied from ${source}; peers=${config.peers.length} seedPeers=${config.mesh.seedPeers.length}`);
    };

    if (config.peerRegistry?.filePath) {
      try {
        const text = readFileSync(config.peerRegistry.filePath, "utf8");
        const parsed = parsePeerRegistryPayload(JSON.parse(text));
        applyPeerRegistrySnapshot(parsed, config.peerRegistry.filePath);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn(`a2a-gateway: failed to load peer registry "${config.peerRegistry.filePath}": ${message}`);
      }
    }

    const telemetry = new GatewayTelemetry(api.logger, {
      structuredLogs: config.observability.structuredLogs,
    });
    const auditLogger = new AuditLogger(config.observability.auditLogPath);
    const pushStore = new PushNotificationStore();
    const client = new A2AClient();
    const taskStore = new FileTaskStore(config.storage.tasksDir);
    const baseExecutor = new OpenClawAgentExecutor(api, config);
    const executor = new QueueingAgentExecutor(
      baseExecutor,
      telemetry,
      config.limits,
    );
    const agentCard = buildAgentCard(config);

    // Peer resilience: health check + circuit breaker
    const healthManager = config.peers.length > 0
      ? new PeerHealthManager(
          config.peers,
          config.resilience.healthCheck,
          config.resilience.circuitBreaker,
          async (peer) => {
            try {
              const card = await client.discoverAgentCard(peer, config.resilience.healthCheck.timeoutMs);
              // Cache skills from Agent Card for routing rule matching
              const skills = Array.isArray(card?.skills)
                ? (card.skills as Array<Record<string, unknown>>)
                    .map((s) => (typeof s === "string" ? s : typeof s?.id === "string" ? s.id : ""))
                    .filter((id) => id.length > 0)
                : [];
              healthManager!.updateSkills(peer.name, skills);
              return true;
            } catch {
              return false;
            }
          },
          (level, msg, details) => {
            if (level === "error") {
              api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            } else if (level === "warn") {
              api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            } else {
              api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
            }
          },
        )
      : null;

    // DNS-SD discovery manager (disabled by default)
    const discoveryManager = config.discovery.enabled
      ? new DnsDiscoveryManager(config.discovery, (level, msg, details) => {
          if (level === "error") {
            api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else if (level === "warn") {
            api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else {
            api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          }
        })
      : null;

    // mDNS responder for self-advertisement (disabled by default)
    const mdnsResponder = config.advertise.enabled
      ? new MdnsResponder(config.advertise, (level, msg, details) => {
          if (level === "error") {
            api.logger.error(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else if (level === "warn") {
            api.logger.warn(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          } else {
            api.logger.info(details ? `${msg}: ${JSON.stringify(details)}` : msg);
          }
        })
      : null;

    /**
     * Get the effective peer list: static peers merged with discovered peers.
     * Static peers always take precedence on name collision.
     */
    const getEffectivePeers = (): PeerConfig[] => {
      if (!discoveryManager) return config.peers;
      if (!config.discovery.mergeWithStatic) {
        return discoveryManager.toPeerConfigs();
      }
      return mergeWithStaticPeers(config.peers, discoveryManager.getDiscoveredPeers());
    };

    const localMeshSkills = config.agentCard.skills
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        const value = asObject(entry);
        return asString(value.id, "").trim() || asString(value.name, "").trim();
      })
      .filter((v): v is string => v.length > 0);

    const localMeshPeerToken = config.security.token
      || (Array.isArray(config.security.tokens) ? (config.security.tokens[0] || "") : "")
      || [...config.security.validTokens][0]
      || "";
    const localMeshPeer: PeerConfig = {
      name: config.mesh.nodeId,
      agentCardUrl: `http://127.0.0.1:${config.server.port}${normalizeCardPath()}`,
      auth: config.security.inboundAuth === "bearer" && localMeshPeerToken
        ? { type: "bearer", token: localMeshPeerToken }
        : undefined,
    };

    const meshManager = config.mesh.enabled
      ? new MeshNetworkManager({
          config: config.mesh,
          localSkills: localMeshSkills,
          localCapabilities: config.mesh.capabilities,
          client,
          getPeers: getEffectivePeers,
          localPeer: localMeshPeer,
          logger: api.logger,
        })
      : null;

    if (meshManager) {
      baseExecutor.setMeshControlPlane(meshManager);
    }

    /**
     * Look up a peer by name from the effective peer list.
     */
    const findPeer = (name: string): PeerConfig | undefined => {
      return getEffectivePeers().find((p) => p.name === name);
    };

    let peerRegistryTimer: ReturnType<typeof setInterval> | null = null;
    let peerRegistrySignature = "";

    const computePeerRegistrySignature = (snapshot: { peers: PeerConfig[]; seedPeers: PeerConfig[] }): string => {
      return JSON.stringify({
        peers: snapshot.peers.map((p) => `${p.name}|${p.agentCardUrl}|${p.auth?.type || ""}|${p.auth?.token || ""}`),
        seedPeers: snapshot.seedPeers.map((p) => `${p.name}|${p.agentCardUrl}|${p.auth?.type || ""}|${p.auth?.token || ""}`),
      });
    };

    const reloadPeerRegistry = async (): Promise<void> => {
      if (!config.peerRegistry?.filePath) return;
      try {
        const text = await readFile(config.peerRegistry.filePath, "utf8");
        const parsed = parsePeerRegistryPayload(JSON.parse(text));
        const signature = computePeerRegistrySignature(parsed);
        if (signature === peerRegistrySignature) return;
        applyPeerRegistrySnapshot(parsed, config.peerRegistry.filePath);
        peerRegistrySignature = signature;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn(`a2a-gateway: peer registry reload failed "${config.peerRegistry.filePath}": ${message}`);
      }
    };

    peerRegistrySignature = computePeerRegistrySignature({
      peers: config.peers,
      seedPeers: config.mesh.seedPeers,
    });

    // Wire peer state into telemetry snapshot
    if (healthManager) {
      telemetry.setPeerStateProvider(() => healthManager.getAllStates());
    }

    // Wire audit logger + push notifications for inbound task completion
    telemetry.setTaskAuditCallback((taskId, contextId, state, durationMs) => {
      auditLogger.recordInbound(taskId, contextId, state, durationMs);

      // Fire-and-forget push notification for terminal states
      if (pushStore.has(taskId) && (state === "completed" || state === "failed" || state === "canceled")) {
        taskStore.load(taskId).then((task) => {
          if (!task) return;
          return pushStore.send(taskId, state, task);
        }).then((result) => {
          if (result && result.ok) {
            api.logger.info(`a2a-gateway: push notification sent for task ${taskId} (${state})`);
          } else if (result) {
            api.logger.warn(`a2a-gateway: push notification failed for task ${taskId}: ${result.error}`);
          }
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          api.logger.warn(`a2a-gateway: push notification error for task ${taskId}: ${msg}`);
        });
      }
    });

    // SDK expects userBuilder(req) -> Promise<User>
    // When bearer auth is configured, validate the Authorization header.
    const userBuilder = async (req: { headers?: Record<string, string | string[] | undefined> }) => {
      if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
        const authHeader = req.headers?.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const providedToken = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!providedToken || !config.security.validTokens.has(providedToken)) {
          telemetry.recordSecurityRejection("http", "invalid or missing bearer token");
          auditLogger.recordSecurityEvent("http", "invalid or missing bearer token");
          throw jsonRpcError(null, -32000, "Unauthorized: invalid or missing bearer token");
        }
      }
      return UserBuilder.noAuthentication();
    };

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

    const app = express();
    const createHttpMetricsMiddleware =
      (route: "jsonrpc" | "rest" | "metrics") =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        const startedAt = Date.now();
        res.on("finish", () => {
          telemetry.recordInboundHttp(route, res.statusCode, Date.now() - startedAt);
        });
        next();
      };

    const cardPath = normalizeCardPath();
    const cardEndpointHandler = agentCardHandler({ agentCardProvider: requestHandler });

    app.use(cardPath, cardEndpointHandler);
    if (cardPath != "/.well-known/agent.json") {
      app.use("/.well-known/agent.json", cardEndpointHandler);
    }

    app.use(
      "/a2a/jsonrpc",
      createHttpMetricsMiddleware("jsonrpc"),
      jsonRpcHandler({
        requestHandler,
        userBuilder,
      })
    );

    // Ensure errors return JSON-RPC style responses (avoid Express HTML error pages)
    app.use("/a2a/jsonrpc", (err: unknown, _req: unknown, res: any, next: (e?: unknown) => void) => {
      if (err instanceof SyntaxError) {
        res.status(400).json(jsonRpcError(null, -32700, "Parse error"));
        return;
      }

      // Surface A2A-specific errors with proper codes
      const a2aErr = err as { code?: number; message?: string; taskId?: string } | undefined;
      if (a2aErr && typeof a2aErr.code === "number") {
        const status = a2aErr.code === -32601 ? 404 : 400;
        res.status(status).json(jsonRpcError(null, a2aErr.code, a2aErr.message || "Unknown error"));
        return;
      }

      // Generic internal error
      res.status(500).json(jsonRpcError(null, -32603, "Internal error"));
    });

    app.use(
      "/a2a/rest",
      createHttpMetricsMiddleware("rest"),
      restHandler({
        requestHandler,
        userBuilder,
      })
    );

    if (config.observability.exposeMetricsEndpoint) {
      app.get(
        config.observability.metricsPath,
        createHttpMetricsMiddleware("metrics"),
        (req, res, next) => {
          if (config.observability.metricsAuth === "bearer" && config.security.validTokens.size > 0) {
            const authHeader = req.headers.authorization;
            const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
            const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
            if (!token || !config.security.validTokens.has(token)) {
              res.status(401).json({ error: "Unauthorized: invalid or missing bearer token" });
              return;
            }
          }
          next();
        },
        (_req, res) => {
          res.json(telemetry.snapshot());
        },
      );
    }

    // Bearer auth middleware for push notification endpoints
    const pushAuthMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
        const authHeader = req.headers.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token || !config.security.validTokens.has(token)) {
          res.status(401).json({ error: "Unauthorized: invalid or missing bearer token" });
          return;
        }
      }
      next();
    };

    // REST endpoints for push notification registration
    app.post("/a2a/push/register", pushAuthMiddleware, express.json(), async (req, res) => {
      const body = asObject(req.body);
      const taskId = asString(body.taskId, "");
      const url = asString(body.url, "");
      if (!taskId || !url) {
        res.status(400).json({ error: "taskId and url are required" });
        return;
      }

      // SSRF validation: reuse file-security's URI validation
      const uriCheck = await validateUri(url, config.security);
      if (!uriCheck.ok) {
        res.status(400).json({ error: `Webhook URL rejected: ${uriCheck.reason}` });
        return;
      }

      const token = asString(body.token, "") || undefined;
      const events = Array.isArray(body.events)
        ? (body.events as unknown[]).filter((e): e is string => typeof e === "string")
        : undefined;
      pushStore.register(taskId, { url, token, events });
      res.json({ taskId, registered: true });
    });

    app.delete("/a2a/push/:taskId", pushAuthMiddleware, (req, res) => {
      const rawTaskId = req.params.taskId;
      const taskId = typeof rawTaskId === "string" ? rawTaskId : "";
      if (!taskId) {
        res.status(400).json({ error: "taskId is required" });
        return;
      }
      const existed = pushStore.has(taskId);
      pushStore.unregister(taskId);
      res.json({ taskId, removed: existed });
    });

    // Mesh demo endpoints (CLI + dashboard)
    app.post("/a2a/mesh/node/start", pushAuthMiddleware, async (_req, res) => {
      if (!meshManager) {
        res.status(404).json({ error: "mesh is disabled" });
        return;
      }
      await meshManager.start();
      res.json({ started: meshManager.isStarted(), node: meshManager.getNodeStatus() });
    });

    app.get("/a2a/mesh/node/status", pushAuthMiddleware, (_req, res) => {
      if (!meshManager) {
        res.status(404).json({ error: "mesh is disabled" });
        return;
      }
      res.json(meshManager.getNodeStatus());
    });

    app.get("/a2a/mesh/neighbors", pushAuthMiddleware, (_req, res) => {
      if (!meshManager) {
        res.status(404).json({ error: "mesh is disabled" });
        return;
      }
      res.json({ neighbors: meshManager.listNeighbors() });
    });

    app.post("/a2a/mesh/task/submit", pushAuthMiddleware, express.json(), async (req, res) => {
      if (!meshManager) {
        res.status(404).json({ error: "mesh is disabled" });
        return;
      }
      const payload = asObject(req.body);
      try {
        const result = await meshManager.submitTask({
          goal: asString(payload.goal, ""),
          requiredSkills: Array.isArray(payload.requiredSkills)
            ? payload.requiredSkills.filter((s): s is string => typeof s === "string")
            : undefined,
          targetNodes: Array.isArray(payload.targetNodes)
            ? payload.targetNodes.filter((s): s is string => typeof s === "string")
            : Array.isArray(payload.selectedNodes)
              ? payload.selectedNodes.filter((s): s is string => typeof s === "string")
              : undefined,
          template: (() => {
            const t = asString(payload.template, "auto");
            return t === "analyze" || t === "build" || t === "review" || t === "auto" ? t : "auto";
          })(),
        });
        res.json(result);
      } catch (error: unknown) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    app.get("/a2a/mesh/task/:taskId", pushAuthMiddleware, (req, res) => {
      if (!meshManager) {
        res.status(404).json({ error: "mesh is disabled" });
        return;
      }
      const taskId = typeof req.params.taskId === "string" ? req.params.taskId : "";
      const task = meshManager.getTask(taskId);
      if (!task) {
        res.status(404).json({ error: "mesh task not found" });
        return;
      }
      res.json(task);
    });

    app.get("/a2a/mesh/state", pushAuthMiddleware, (_req, res) => {
      if (!meshManager) {
        res.status(404).json({ error: "mesh is disabled" });
        return;
      }
      res.json({
        node: meshManager.getNodeStatus(),
        neighbors: meshManager.listNeighbors(),
        tasks: meshManager.listTasks(),
      });
    });

    app.get("/a2a/mesh/dashboard", pushAuthMiddleware, (_req, res) => {
      if (!meshManager) {
        res.status(404).send("mesh is disabled");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.send(renderMeshDashboardHtml());
    });

    let server: Server | null = null;
    let grpcServer: GrpcServer | null = null;
    let cleanupTimer: ReturnType<typeof setInterval> | null = null;
    const grpcPort = config.server.port + 1;

    api.registerGatewayMethod("a2a.metrics", ({ respond }) => {
      respond(true, {
        metrics: telemetry.snapshot(),
      });
    });

    api.registerGatewayMethod("a2a.audit", ({ params, respond }) => {
      const payload = asObject(params);
      const count = Math.min(Math.max(1, asNumber(payload.count, 50)), 500);
      auditLogger
        .tail(count)
        .then((entries) => respond(true, { entries, count: entries.length }))
        .catch((error) => respond(false, { error: String(error?.message || error) }));
    });

    api.registerGatewayMethod("a2a.pushNotification.register", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      const url = asString(payload.url, "");
      if (!taskId || !url) {
        respond(false, { error: "taskId and url are required" });
        return;
      }

      // SSRF validation on webhook URL
      validateUri(url, config.security).then((uriCheck) => {
        if (!uriCheck.ok) {
          respond(false, { error: `Webhook URL rejected: ${uriCheck.reason}` });
          return;
        }
        const token = asString(payload.token, "") || undefined;
        const events = Array.isArray(payload.events)
          ? (payload.events as unknown[]).filter((e): e is string => typeof e === "string")
          : undefined;
        pushStore.register(taskId, { url, token, events });
        respond(true, { taskId, registered: true });
      }).catch((err) => {
        respond(false, { error: `URI validation failed: ${err instanceof Error ? err.message : String(err)}` });
      });
    });

    api.registerGatewayMethod("a2a.pushNotification.unregister", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      if (!taskId) {
        respond(false, { error: "taskId is required" });
        return;
      }
      const existed = pushStore.has(taskId);
      pushStore.unregister(taskId);
      respond(true, { taskId, removed: existed });
    });

    api.registerGatewayMethod("a2a.send", ({ params, respond }) => {
      const payload = asObject(params);
      let peerName = asString(payload.peer || payload.name, "");
      const message = asObject(payload.message || payload.payload);

      // Rule-based routing: auto-select peer when not explicitly provided
      if (!peerName && config.routing.rules.length > 0) {
        const msgText = typeof message.text === "string" ? message.text
          : typeof message.message === "string" ? message.message : "";
        const msgTags = Array.isArray(message.tags)
          ? (message.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [];
        const peerSkills = healthManager?.getPeerSkills();
        const routeMatch = matchRule(config.routing.rules, { text: msgText, tags: msgTags }, peerSkills);
        if (routeMatch) {
          peerName = routeMatch.peer;
          if (routeMatch.agentId && !message.agentId) {
            message.agentId = routeMatch.agentId;
          }
          api.logger.info(`a2a-gateway: rule-based routing matched → peer="${peerName}"${routeMatch.agentId ? ` agentId="${routeMatch.agentId}"` : ""}`);
        }
      }

      const peer = findPeer(peerName);
      if (!peer) {
        const hint = peerName
          ? `Peer not found: ${peerName}`
          : "No peer specified and no routing rule matched";
        respond(false, { error: hint });
        return;
      }

      const startedAt = Date.now();
      const sendOptions = {
        healthManager: healthManager ?? undefined,
        retryConfig: config.resilience.retry,
        log: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => {
          if (details?.attempt) {
            telemetry.recordPeerRetry(peer.name, details.attempt as number);
          }
          api.logger[level](details ? `${msg}: ${JSON.stringify(details)}` : msg);
        },
      };
      client
        .sendMessage(peer, message, sendOptions)
        .then((result) => {
          const outDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, result.ok, result.statusCode, outDuration);
          auditLogger.recordOutbound(peer.name, result.ok, result.statusCode, outDuration);
          if (result.ok) {
            respond(true, {
              statusCode: result.statusCode,
              response: result.response,
            });
            return;
          }

          respond(false, {
            statusCode: result.statusCode,
            response: result.response,
          });
        })
        .catch((error) => {
          const errDuration = Date.now() - startedAt;
          telemetry.recordOutboundRequest(peer.name, false, 500, errDuration);
          auditLogger.recordOutbound(peer.name, false, 500, errDuration);
          respond(false, { error: String(error?.message || error) });
        });
    });

    api.registerGatewayMethod("mesh.node.start", ({ respond }) => {
      if (!meshManager) {
        respond(false, { error: "mesh is disabled" });
        return;
      }
      meshManager.start()
        .then(() => {
          respond(true, {
            started: meshManager.isStarted(),
            node: meshManager.getNodeStatus(),
          });
        })
        .catch((error) => {
          respond(false, { error: String((error as Error)?.message || error) });
        });
    });

    api.registerGatewayMethod("mesh.node.status", ({ respond }) => {
      if (!meshManager) {
        respond(false, { error: "mesh is disabled" });
        return;
      }
      respond(true, meshManager.getNodeStatus());
    });

    api.registerGatewayMethod("mesh.neighbors.list", ({ respond }) => {
      if (!meshManager) {
        respond(false, { error: "mesh is disabled" });
        return;
      }
      respond(true, { neighbors: meshManager.listNeighbors() });
    });

    api.registerGatewayMethod("mesh.task.submit", ({ params, respond }) => {
      if (!meshManager) {
        respond(false, { error: "mesh is disabled" });
        return;
      }
      const payload = asObject(params);
      const goal = asString(payload.goal, "");
      const requiredSkills = Array.isArray(payload.requiredSkills)
        ? payload.requiredSkills.filter((s): s is string => typeof s === "string")
        : undefined;
      const targetNodes = Array.isArray(payload.targetNodes)
        ? payload.targetNodes.filter((s): s is string => typeof s === "string")
        : Array.isArray(payload.selectedNodes)
          ? payload.selectedNodes.filter((s): s is string => typeof s === "string")
          : undefined;
      const templateRaw = asString(payload.template, "auto");
      const template = templateRaw === "analyze" || templateRaw === "build" || templateRaw === "review" || templateRaw === "auto"
        ? templateRaw
        : "auto";

      meshManager.submitTask({ goal, requiredSkills, template, targetNodes })
        .then((result) => respond(true, result))
        .catch((error) => respond(false, { error: String((error as Error)?.message || error) }));
    });

    api.registerGatewayMethod("mesh.task.status", ({ params, respond }) => {
      if (!meshManager) {
        respond(false, { error: "mesh is disabled" });
        return;
      }
      const payload = asObject(params);
      const meshTaskId = asString(payload.meshTaskId || payload.taskId, "");
      if (!meshTaskId) {
        respond(false, { error: "meshTaskId is required" });
        return;
      }
      const task = meshManager.getTask(meshTaskId);
      if (!task) {
        respond(false, { error: "mesh task not found" });
        return;
      }
      respond(true, task);
    });

    // ------------------------------------------------------------------
    // Agent tool: a2a_send_file
    // Lets the agent send a file (by URI) to a peer via A2A FilePart.
    // ------------------------------------------------------------------
    if (api.registerTool) {
      const sendFileParams = {
        type: "object" as const,
        required: ["peer", "uri"],
        properties: {
          peer: { type: "string" as const, description: "Name of the target peer (must match a configured peer name)" },
          uri: { type: "string" as const, description: "Public URL of the file to send" },
          name: { type: "string" as const, description: "Filename (e.g. report.pdf)" },
          mimeType: { type: "string" as const, description: "MIME type (e.g. application/pdf). Auto-detected from extension if omitted." },
          text: { type: "string" as const, description: "Optional text message to include alongside the file" },
          agentId: { type: "string" as const, description: "Route to a specific agentId on the peer (OpenClaw extension). Omit to use the peer's default agent." },
        },
      };

      api.registerTool({
        name: "a2a_send_file",
        description: "Send a file to a peer agent via A2A. The file is referenced by its public URL (URI). " +
          "Use this when you need to transfer a document, image, or any file to another agent.",
        label: "A2A Send File",
        parameters: sendFileParams,
        async execute(toolCallId, params) {
          const peer = findPeer(params.peer);
          if (!peer) {
            const available = getEffectivePeers().map((p) => p.name).join(", ") || "(none)";
            return {
              content: [{ type: "text" as const, text: `Peer not found: "${params.peer}". Available peers: ${available}` }],
              details: { ok: false },
            };
          }

          // Security checks: SSRF, MIME, file size
          const uriCheck = await validateUri(params.uri, config.security);
          if (!uriCheck.ok) {
            return {
              content: [{ type: "text" as const, text: `URI rejected: ${uriCheck.reason}` }],
              details: { ok: false, reason: uriCheck.reason },
            };
          }

          if (params.mimeType && !validateMimeType(params.mimeType, config.security.allowedMimeTypes)) {
            return {
              content: [{ type: "text" as const, text: `MIME type rejected: "${params.mimeType}" is not in the allowed list` }],
              details: { ok: false },
            };
          }

          const parts: Array<Record<string, unknown>> = [];
          if (params.text) {
            parts.push({ kind: "text", text: params.text });
          }
          parts.push({
            kind: "file",
            file: {
              uri: params.uri,
              ...(params.name ? { name: params.name } : {}),
              ...(params.mimeType ? { mimeType: params.mimeType } : {}),
            },
          });

          try {
            const message: Record<string, unknown> = { parts };
            if (params.agentId) {
              message.agentId = params.agentId;
            }
            const result = await client.sendMessage(peer, message, {
              healthManager: healthManager ?? undefined,
              retryConfig: config.resilience.retry,
            });
            if (result.ok) {
              return {
                content: [{ type: "text" as const, text: `File sent to ${params.peer} via A2A.\nURI: ${params.uri}\nResponse: ${JSON.stringify(result.response)}` }],
                details: { ok: true, response: result.response },
              };
            }
            return {
              content: [{ type: "text" as const, text: `Failed to send file to ${params.peer}: ${JSON.stringify(result.response)}` }],
              details: { ok: false, response: result.response },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error sending file to ${params.peer}: ${msg}` }],
              details: { ok: false, error: msg },
            };
          }
        },
      });
    }

    if (!api.registerService) {
      api.logger.warn("a2a-gateway: registerService is unavailable; HTTP endpoints are not started");
      return;
    }

    api.registerService({
      id: "a2a-gateway",
      async start(_ctx) {
        if (server) {
          return;
        }

        // Start DNS-SD discovery (if enabled)
        discoveryManager?.start();

        // Start peer health checks
        healthManager?.start();

        // Start HTTP server (JSON-RPC + REST)
        await new Promise<void>((resolve, reject) => {
          server = app.listen(config.server.port, config.server.host, () => {
            api.logger.info(
              `a2a-gateway: HTTP listening on ${config.server.host}:${config.server.port}`
            );
            api.logger.info(
              `a2a-gateway: durable task store at ${config.storage.tasksDir}; concurrency=${config.limits.maxConcurrentTasks}; queue=${config.limits.maxQueuedTasks}`
            );
            resolve();
          });

          server!.once("error", reject);
        });

        // Start gRPC server
        try {
          grpcServer = new GrpcServer();
          const grpcUserBuilder = async (
            call: { metadata?: { get: (key: string) => unknown[] } } | unknown,
          ) => {
            if (config.security.inboundAuth === "bearer" && config.security.validTokens.size > 0) {
              const meta = (call as any)?.metadata;
              const values = meta?.get?.("authorization") || meta?.get?.("Authorization") || [];
              const header = Array.isArray(values) && values.length > 0 ? String(values[0]) : "";
              const providedToken = header.startsWith("Bearer ") ? header.slice(7) : "";
              if (!providedToken || !config.security.validTokens.has(providedToken)) {
                telemetry.recordSecurityRejection("grpc", "invalid or missing bearer token");
                auditLogger.recordSecurityEvent("grpc", "invalid or missing bearer token");
                const err: any = new Error("Unauthorized: invalid or missing bearer token");
                err.code = GrpcStatus.UNAUTHENTICATED;
                throw err;
              }
            }
            return GrpcUserBuilder.noAuthentication();
          };

          grpcServer.addService(
            A2AService,
            grpcService({ requestHandler, userBuilder: grpcUserBuilder as any })
          );

          await new Promise<void>((resolve, reject) => {
            grpcServer!.bindAsync(
              `${config.server.host}:${grpcPort}`,
              ServerCredentials.createInsecure(),
              (error) => {
                if (error) {
                  api.logger.warn(`a2a-gateway: gRPC failed to start: ${error.message}`);
                  grpcServer = null;
                  resolve(); // Non-fatal: HTTP still works
                  return;
                }
                try {
                  grpcServer!.start();
                } catch {
                  // ignore: some grpc-js versions auto-start
                }
                api.logger.info(
                  `a2a-gateway: gRPC listening on ${config.server.host}:${grpcPort}`
                );
                resolve();
              }
            );
          });
        } catch (grpcError: unknown) {
          const msg = grpcError instanceof Error ? grpcError.message : String(grpcError);
          api.logger.warn(`a2a-gateway: gRPC init failed: ${msg}`);
          grpcServer = null;
        }

        // Start task TTL cleanup
        const ttlMs = config.storage.taskTtlHours * 3_600_000;
        const intervalMs = config.storage.cleanupIntervalMinutes * 60_000;

        const doCleanup = () => {
          void runTaskCleanup(taskStore, ttlMs, telemetry, api.logger);
        };

        // Run once at startup to clear any backlog
        doCleanup();
        cleanupTimer = setInterval(doCleanup, intervalMs);

        api.logger.info(
          `a2a-gateway: task cleanup enabled — ttl=${config.storage.taskTtlHours}h interval=${config.storage.cleanupIntervalMinutes}min`,
        );

        // Start mDNS self-advertisement (after HTTP is listening)
        mdnsResponder?.start();

        // Hot-reload peer/seed lists from external JSON file (optional).
        if (config.peerRegistry?.filePath) {
          await reloadPeerRegistry();
          peerRegistryTimer = setInterval(() => {
            void reloadPeerRegistry();
          }, config.peerRegistry.pollIntervalMs);
          api.logger.info(`a2a-gateway: peer registry watcher enabled file=${config.peerRegistry.filePath} intervalMs=${config.peerRegistry.pollIntervalMs}`);
        }

        // Start mesh heartbeat/control plane after server is reachable.
        if (meshManager) {
          await meshManager.start();
          api.logger.info(`a2a-gateway: mesh enabled nodeId=${config.mesh.nodeId} runtime=${config.mesh.runtimeType}`);
        }
      },
      async stop(_ctx) {
        if (peerRegistryTimer) {
          clearInterval(peerRegistryTimer);
          peerRegistryTimer = null;
        }

        meshManager?.stop();

        // Stop mDNS self-advertisement (sends goodbye packet)
        mdnsResponder?.stop();

        // Stop DNS-SD discovery
        discoveryManager?.stop();

        // Stop peer health checks
        healthManager?.stop();
        auditLogger.close();

        // Stop task cleanup timer
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = null;
        }

        // Stop gRPC server
        if (grpcServer) {
          grpcServer.forceShutdown();
          grpcServer = null;
        }

        // Stop HTTP server
        if (!server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const activeServer = server!;
          server = null;
          activeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  },
};

export default plugin;
