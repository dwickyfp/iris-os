"use client";

import { Markdown } from "@/components/markdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "ui/tabs";
import { Textarea } from "ui/textarea";

interface SkillBodyEditorProps {
  body: string;
  disabled?: boolean;
  onChange: (body: string) => void;
}

export function SkillBodyEditor({
  body,
  disabled,
  onChange,
}: SkillBodyEditorProps) {
  return (
    <Tabs defaultValue={disabled ? "preview" : "edit"} className="gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">SKILL.md</h2>
          <p className="text-xs text-muted-foreground">
            Instructions loaded when this skill is selected.
          </p>
        </div>
        <TabsList>
          {!disabled && <TabsTrigger value="edit">Edit</TabsTrigger>}
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
      </div>
      {!disabled && (
        <TabsContent value="edit">
          <Textarea
            aria-label="SKILL.md body"
            value={body}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-96 resize-y font-mono text-sm leading-6"
            placeholder="# Instructions"
          />
        </TabsContent>
      )}
      <TabsContent value="preview">
        <div className="min-h-96 rounded-md border bg-secondary/20 px-5 py-2">
          {body ? (
            <Markdown>{body}</Markdown>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing to preview yet.
            </p>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
