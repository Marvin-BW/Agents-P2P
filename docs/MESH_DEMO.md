# Mesh/P2P Demo Guide

This document describes the minimal mesh collaboration demo added on top of the A2A gateway.

## What It Adds

- Mesh control frames over A2A `DataPart` with mime type `application/vnd.a2a.mesh+json`
- Neighbor management with heartbeat-based status (`online` / `suspect` / `offline`)
- Task orchestration with templates (`analyze` / `build` / `review`) and auto topology selection (`serial` / `star` / `full-mesh`)
- Gateway methods for mesh control + task submit/status
- HTTP endpoints for CLI and a minimal web dashboard
- Optional Ollama A2A adapter process for mesh participation

## Config

Add under plugin config:

```json
{
  "mesh": {
    "enabled": true,
    "nodeId": "node-a",
    "runtimeType": "openclaw",
    "seedPeers": [
      {
        "name": "node-b",
        "agentCardUrl": "http://100.64.0.2:18800/.well-known/agent-card.json",
        "auth": { "type": "bearer", "token": "peer-token" }
      }
    ],
    "coordinator": {
      "fallbackNodeId": "node-coordinator"
    },
    "heartbeat": {
      "intervalMs": 5000,
      "suspectThreshold": 3,
      "offlineThreshold": 5
    },
    "scheduler": {
      "maxFanout": 4,
      "fullMeshMaxNodes": 6
    }
  }
}
```

### Optional: External Peer Registry (No Restart for Node Add/Remove)

You can keep peer definitions in a JSON file and let gateway hot-reload it:

```json
{
  "peerRegistry": {
    "filePath": "./data/mesh-peers.json",
    "pollIntervalMs": 5000
  }
}
```

`mesh-peers.json` supports either:

1) Array format (used for both `peers` and `mesh.seedPeers`)

```json
[
  { "name": "node-coordinator-cloud", "agentCardUrl": "http://100.91.248.6:18800/.well-known/agent.json" },
  { "name": "node-worker-32", "agentCardUrl": "http://100.114.24.56:18800/.well-known/agent.json" },
  { "name": "node-ollama-win", "agentCardUrl": "http://100.98.187.62:18900/.well-known/agent.json" }
]
```

2) Object format (separate `peers` and `seedPeers`)

```json
{
  "peers": [
    { "name": "node-coordinator-cloud", "agentCardUrl": "http://100.91.248.6:18800/.well-known/agent.json" }
  ],
  "seedPeers": [
    { "name": "node-coordinator-cloud", "agentCardUrl": "http://100.91.248.6:18800/.well-known/agent.json" }
  ]
}
```

When `peerRegistry` is enabled on the coordinator:

- OpenClaw/Ollama nodes send `ANNOUNCE` on startup.
- If `ANNOUNCE.payload.agentCardUrl` is present, coordinator auto-upserts that node into `peers` and `seedPeers`.
- Coordinator persists updates back to `mesh-peers.json` without restart.

For OpenClaw nodes, set `agentCard.url` to a reachable address (for example Tailscale IP), otherwise auto-registered URLs may fall back to localhost.

## Gateway Methods

- `mesh.node.start`
- `mesh.node.status`
- `mesh.neighbors.list`
- `mesh.task.submit`
- `mesh.task.status`

`mesh.task.submit` input:

```json
{
  "goal": "Analyze incident and propose fixes",
  "requiredSkills": ["analysis", "review"],
  "template": "auto"
}
```

## HTTP Endpoints

- `POST /a2a/mesh/node/start`
- `GET /a2a/mesh/node/status`
- `GET /a2a/mesh/neighbors`
- `POST /a2a/mesh/task/submit`
- `GET /a2a/mesh/task/:taskId`
- `GET /a2a/mesh/state`
- `GET /a2a/mesh/dashboard`

## CLI

Use:

```bash
npm run mesh:cli -- node start
npm run mesh:cli -- node status
npm run mesh:cli -- neighbors list
npm run mesh:cli -- task submit --goal "Review architecture" --template auto --required-skills review,analysis
npm run mesh:cli -- task status <meshTaskId>
```

Optional env vars:

- `MESH_BASE_URL` (default `http://localhost:18800`)
- `MESH_TOKEN` (bearer token when inbound auth is enabled)

## Ollama Adapter

Run:

```bash
npm run mesh:ollama-adapter
```

Environment variables:

- `ADAPTER_HOST` (default `0.0.0.0`)
- `ADAPTER_PORT` (default `18900`)
- `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (default `llama3.2`)
- `MESH_NODE_ID` (default `ollama-<hostname>`)
- `OLLAMA_SKILLS` (comma-separated, default `chat,analysis,build,review`)
