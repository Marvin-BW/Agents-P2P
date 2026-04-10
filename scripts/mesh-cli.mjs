#!/usr/bin/env node

/**
 * Mesh demo CLI for openclaw-a2a-gateway.
 *
 * Examples:
 *   node scripts/mesh-cli.mjs node start
 *   node scripts/mesh-cli.mjs node status
 *   node scripts/mesh-cli.mjs neighbors list
 *   node scripts/mesh-cli.mjs task submit --goal "Review this design" --template auto --required-skills review,architecture
 *   node scripts/mesh-cli.mjs task status <meshTaskId>
 */

const DEFAULT_BASE_URL = process.env.MESH_BASE_URL || "http://localhost:18800";
const DEFAULT_TOKEN = process.env.MESH_TOKEN || "";

function usage(exitCode = 1) {
  const text = `
Usage:
  mesh-cli node start [--base-url <url>] [--token <token>]
  mesh-cli node status [--base-url <url>] [--token <token>]
  mesh-cli neighbors list [--base-url <url>] [--token <token>]
  mesh-cli task submit --goal <text> [--template auto|analyze|build|review] [--required-skills a,b,c] [--base-url <url>] [--token <token>]
  mesh-cli task status <meshTaskId> [--base-url <url>] [--token <token>]

Env:
  MESH_BASE_URL
  MESH_TOKEN
`;
  (exitCode === 0 ? console.log : console.error)(text.trim());
  process.exit(exitCode);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage(argv.length === 0 ? 1 : 0);
  }

  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, options };
}

function normalizeBaseUrl(raw) {
  const value = String(raw || DEFAULT_BASE_URL).trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function headers(token) {
  const result = { "content-type": "application/json" };
  if (token) {
    result.authorization = `Bearer ${token}`;
  }
  return result;
}

async function request(method, url, body, token) {
  const res = await fetch(url, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function buildTaskStatusCommand(baseUrl, token, meshTaskId) {
  const envParts = [`MESH_BASE_URL="${baseUrl}"`];
  if (token) {
    envParts.push(`MESH_TOKEN="${token}"`);
  }
  return `${envParts.join(" ")} npm run mesh:cli -- task status ${meshTaskId}`;
}
async function main() {
  const { positional, options } = parseArgs();
  const [group, action, arg3] = positional;
  const baseUrl = normalizeBaseUrl(options["base-url"]);
  const token = String(options.token || DEFAULT_TOKEN).trim();

  if (group === "node" && action === "start") {
    const result = await request("POST", `${baseUrl}/a2a/mesh/node/start`, {}, token);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (group === "node" && action === "status") {
    const result = await request("GET", `${baseUrl}/a2a/mesh/node/status`, undefined, token);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (group === "neighbors" && action === "list") {
    const result = await request("GET", `${baseUrl}/a2a/mesh/neighbors`, undefined, token);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (group === "task" && action === "submit") {
    const goal = String(options.goal || "").trim();
    if (!goal) {
      throw new Error("--goal is required");
    }
    const templateRaw = String(options.template || "auto");
    const template = ["auto", "analyze", "build", "review"].includes(templateRaw) ? templateRaw : "auto";
    const requiredSkills = String(options["required-skills"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const result = await request("POST", `${baseUrl}/a2a/mesh/task/submit`, {
      goal,
      template,
      ...(requiredSkills.length > 0 ? { requiredSkills } : {}),
    }, token);
    console.log(JSON.stringify(result, null, 2));
    const meshTaskId = typeof result?.meshTaskId === "string" ? result.meshTaskId : "";
    if (meshTaskId) {
      console.log(buildTaskStatusCommand(baseUrl, token, meshTaskId));
    }
    return;
  }

  if (group === "task" && action === "status") {
    const taskId = String(arg3 || "").trim();
    if (!taskId) {
      throw new Error("meshTaskId is required");
    }
    const result = await request("GET", `${baseUrl}/a2a/mesh/task/${encodeURIComponent(taskId)}`, undefined, token);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  usage(1);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});

