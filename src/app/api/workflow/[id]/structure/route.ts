import { getSession } from "auth/server";
import { persistedWorkflowNodeKinds } from "lib/ai/workflow/workflow.interface";
import { workflowRepository } from "lib/db/repository";
import { z } from "zod";

const structureSchema = z.object({
  nodes: z.array(
    z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1),
        kind: z
          .string()
          .refine((kind) => persistedWorkflowNodeKinds.has(kind), {
            message: "Unsupported workflow node kind",
          }),
        nodeConfig: z.record(z.string(), z.unknown()),
        uiConfig: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  ),
  edges: z.array(
    z
      .object({
        id: z.string().uuid(),
        source: z.string().uuid(),
        target: z.string().uuid(),
        uiConfig: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  ),
  deleteNodes: z.array(z.string().uuid()).optional(),
  deleteEdges: z.array(z.string().uuid()).optional(),
});

export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const hasAccess = await workflowRepository.checkAccess(id, session.user.id);
  if (!hasAccess) {
    return new Response("Unauthorized", { status: 401 });
  }
  const workflow = await workflowRepository.selectStructureById(id);
  return Response.json(workflow);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const parsed = structureSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow structure", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { nodes, edges, deleteNodes, deleteEdges } = parsed.data;
  const { id } = await params;
  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const hasAccess = await workflowRepository.checkAccess(
    id,
    session.user.id,
    false,
  );
  if (!hasAccess) {
    return new Response("Unauthorized", { status: 401 });
  }
  const current = await workflowRepository.selectStructureById(id);
  if (!current) return new Response("Workflow not found", { status: 404 });
  const deletedNodeIds = new Set(deleteNodes ?? []);
  const updatedNodeKinds = new Map(nodes.map((node) => [node.id, node.kind]));
  const resultingKinds = current.nodes
    .filter((node) => !deletedNodeIds.has(node.id))
    .map((node) => updatedNodeKinds.get(node.id) ?? node.kind)
    .concat(
      nodes
        .filter((node) => !current.nodes.some(({ id }) => id === node.id))
        .map((node) => node.kind),
    );
  if (resultingKinds.some((kind) => !persistedWorkflowNodeKinds.has(kind))) {
    return Response.json(
      { error: "Remove retired workflow nodes before saving" },
      { status: 409 },
    );
  }
  const resultingNodeIds = new Set(
    current.nodes
      .filter((node) => !deletedNodeIds.has(node.id))
      .map((node) => node.id)
      .concat(nodes.map((node) => node.id)),
  );
  const deletedEdgeIds = new Set(deleteEdges ?? []);
  const updatedEdges = new Map(edges.map((edge) => [edge.id, edge]));
  const resultingEdges = current.edges
    .filter((edge) => !deletedEdgeIds.has(edge.id))
    .map((edge) => updatedEdges.get(edge.id) ?? edge)
    .concat(
      edges.filter(
        (edge) => !current.edges.some(({ id }) => id === edge.id),
      ) as any,
    );
  if (
    resultingEdges.some(
      (edge) =>
        !resultingNodeIds.has(edge.source) ||
        !resultingNodeIds.has(edge.target),
    )
  ) {
    return Response.json(
      { error: "Workflow edges must reference retained nodes" },
      { status: 409 },
    );
  }
  await workflowRepository.saveStructure({
    workflowId: id,
    nodes: nodes.map((v) => ({
      ...v,
      workflowId: id,
    })) as any,
    edges: edges.map((v) => ({
      ...v,
      workflowId: id,
    })) as any,
    deleteNodes,
    deleteEdges,
  });

  return Response.json({ success: true });
}
