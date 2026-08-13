import { getModelCatalog } from "lib/ai/models";

export const GET = async () => {
  return Response.json(await getModelCatalog());
};
