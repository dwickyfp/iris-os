import { getSession } from "auth/server";
import { LearningSettingsUpdateSchema } from "app-types/learning";
import { isV2FeatureEnabled } from "lib/feature-flags";
import {
  getLearningSettings,
  updateLearningSettings,
} from "lib/learning/settings";

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(await getLearningSettings(session.user.id));
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const input = LearningSettingsUpdateSchema.parse(await request.json());
  return Response.json(await updateLearningSettings(session.user.id, input));
}
