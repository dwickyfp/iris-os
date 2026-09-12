import { ChatExportCommentCreateSchema } from "app-types/chat-export";
import { TipTapMentionJsonContent } from "app-types/util";
import { chatExportRepository } from "lib/db/repository";
import { getUserId } from "../actions";

export async function addExportChatCommentAction(data: {
  exportId: string;
  content: TipTapMentionJsonContent;
  parentId?: string;
}) {
  const userId = await getUserId();
  const validatedData = ChatExportCommentCreateSchema.parse({
    ...data,
    authorId: userId,
  });
  return await chatExportRepository.insertComment(validatedData);
}
