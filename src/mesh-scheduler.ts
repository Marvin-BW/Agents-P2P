import type {
  MeshNeighborNode,
  MeshSchedulerConfig,
  MeshTemplate,
  MeshTopology,
} from "./mesh-types.js";

export function inferMeshTemplate(goal: string): MeshTemplate {
  const normalized = goal.toLowerCase();
  if (/(review|audit|cross[- ]?check|critique)/i.test(normalized)) {
    return "review";
  }
  if (/(build|implement|develop|code|deploy|release)/i.test(normalized)) {
    return "build";
  }
  return "analyze";
}

export function chooseMeshTopology(
  template: MeshTemplate,
  participantCount: number,
  scheduler: MeshSchedulerConfig,
): MeshTopology {
  if (template === "review") {
    return participantCount <= scheduler.fullMeshMaxNodes ? "full-mesh" : "star";
  }
  if (template === "build") {
    return "serial";
  }
  return "star";
}

export function scoreMeshNode(node: MeshNeighborNode, requiredSkills: string[]): number {
  if (node.status !== "online") return -1;

  const normalizedRequired = requiredSkills.map((s) => s.trim()).filter(Boolean);
  const skillHit = normalizedRequired.length === 0
    ? 1
    : normalizedRequired.filter((skill) => node.skills.includes(skill)).length / normalizedRequired.length;

  const runtimeBoost = node.runtimeType === "ollama-adapter" ? 0.03 : 0.06;
  const latencyPenalty = normalizePenalty(node.latencyMs ?? node.latencyHint, 350, 0.25);
  const costPenalty = normalizePenalty(node.costHint, 1.5, 0.2);

  return Number((skillHit + runtimeBoost - latencyPenalty - costPenalty).toFixed(6));
}

export function selectMeshNodes(
  candidates: MeshNeighborNode[],
  requiredSkills: string[],
  maxCount: number,
): MeshNeighborNode[] {
  const scored = candidates
    .map((node) => ({ node, score: scoreMeshNode(node, requiredSkills) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.node.nodeId.localeCompare(b.node.nodeId);
    });

  return scored.slice(0, Math.max(1, maxCount)).map((item) => item.node);
}

function normalizePenalty(value: number, divisor: number, maxPenalty: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const raw = value / divisor;
  return Math.min(raw, maxPenalty);
}
