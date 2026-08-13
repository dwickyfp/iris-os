"use client";

import { appStore } from "@/app/store";
import { SelectModel } from "@/components/select-model";
import { experimental_useObject } from "@ai-sdk/react";
import { ChatModel } from "app-types/chat";
import { SkillGenerateSchema } from "app-types/skill";
import { CommandIcon, CornerRightUpIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { MessageLoading } from "ui/message-loading";
import { handleErrorWithToast } from "ui/shared-toast";
import { Textarea } from "ui/textarea";

type GeneratedSkill = Partial<
  Pick<
    typeof SkillGenerateSchema._output,
    "name" | "description" | "compatibility" | "allowedTools" | "body"
  >
>;

type StreamingSkill = Omit<GeneratedSkill, "allowedTools"> & {
  allowedTools?: Array<string | undefined>;
};

function normalizeGeneratedSkill(skill: StreamingSkill): GeneratedSkill {
  return {
    ...skill,
    allowedTools: skill.allowedTools?.filter(
      (tool): tool is string => typeof tool === "string",
    ),
  };
}

interface GenerateSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSkillChange: (skill: GeneratedSkill) => void;
}

export function GenerateSkillDialog({
  open,
  onOpenChange,
  onSkillChange,
}: GenerateSkillDialogProps) {
  const [generateModel, setGenerateModel] = useState<ChatModel | undefined>(
    appStore.getState().chatModel,
  );
  const [prompt, setPrompt] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const { submit, isLoading, object } = experimental_useObject({
    api: "/api/skill/ai",
    schema: SkillGenerateSchema,
    onFinish(event) {
      if (event.error) handleErrorWithToast(event.error);
      if (event.object) onSkillChange(normalizeGeneratedSkill(event.object));
      onOpenChange(false);
      setPrompt("");
      setSubmittedPrompt("");
      setGenerateModel(appStore.getState().chatModel);
    },
  });

  useEffect(() => {
    if (object && isLoading) onSkillChange(normalizeGeneratedSkill(object));
  }, [isLoading, object, onSkillChange]);

  const generate = () => {
    const value = prompt.trim();
    if (!value) return;
    setSubmittedPrompt(value);
    submit({ message: value, chatModel: generateModel });
    setPrompt("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-full xl:max-w-[40vw]">
        <DialogHeader>
          <DialogTitle>Generate skill</DialogTitle>
          <DialogDescription>
            Describe the skill you need. AI will create an editable draft.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-6">
          <div className="px-4">
            <p className="max-w-2/3 rounded-lg bg-secondary p-4">
              What should this skill help an agent do? Include its goal,
              expected output, and any rules it must follow.
            </p>
          </div>
          <div className="flex justify-end px-4">
            <p className="rounded-lg bg-primary px-6 py-4 text-sm text-primary-foreground">
              {isLoading && submittedPrompt ? (
                submittedPrompt
              ) : (
                <MessageLoading className="size-4" />
              )}
            </p>
          </div>
          <div className="flex flex-col rounded-lg border p-4">
            <Textarea
              autoFocus
              className="min-h-24 max-h-48 w-full resize-none border-none! pb-6 ring-0!"
              data-testid="skill-generate-prompt-textarea"
              disabled={isLoading}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.metaKey && !isLoading) {
                  event.preventDefault();
                  generate();
                }
              }}
              placeholder="For example: Create a skill that turns release notes into a concise customer update."
              value={prompt}
            />
            <div className="flex items-center justify-end gap-2">
              <SelectModel showProvider onSelect={setGenerateModel} />
              <Button
                className="text-xs"
                data-testid="skill-generate-prompt-submit-button"
                disabled={!prompt.trim() || isLoading}
                onClick={generate}
                size="sm"
              >
                <span className="mr-1">
                  {isLoading ? "Generating..." : "Send"}
                </span>
                {isLoading ? (
                  <div className="size-3 animate-spin rounded-full border border-current border-t-transparent" />
                ) : (
                  <>
                    <CommandIcon className="size-3" />
                    <CornerRightUpIcon className="size-3" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
