"use client";

import type { SkillFile } from "app-types/skill";
import { isValidSkillFilePath } from "app-types/skill";
import { FilePlus2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";

interface SkillFileManagerProps {
  files: SkillFile[];
  disabled?: boolean;
  onChange: (files: SkillFile[]) => void;
}

const DEFAULT_PATH = "references/notes.md";

function textFile(path: string, content: string): SkillFile {
  return {
    path,
    content,
    mimeType: path.endsWith(".json")
      ? "application/json"
      : "text/plain; charset=utf-8",
    size: new TextEncoder().encode(content).byteLength,
  };
}

export function SkillFileManager({
  files,
  disabled,
  onChange,
}: SkillFileManagerProps) {
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? null);
  const selected = files.find((file) => file.path === selectedPath);

  const addFile = () => {
    let path = DEFAULT_PATH;
    let suffix = 2;
    while (files.some((file) => file.path === path)) {
      path = `references/notes-${suffix}.md`;
      suffix += 1;
    }
    onChange([...files, textFile(path, "")]);
    setSelectedPath(path);
  };

  const renameFile = (path: string) => {
    if (
      path === selectedPath ||
      !isValidSkillFilePath(path) ||
      files.some((file) => file.path === path)
    ) {
      return;
    }
    onChange(
      files.map((file) =>
        file.path === selectedPath ? { ...file, path } : file,
      ),
    );
    setSelectedPath(path);
  };

  const deleteFile = () => {
    const next = files.filter((file) => file.path !== selectedPath);
    onChange(next);
    setSelectedPath(next[0]?.path ?? null);
  };

  return (
    <section className="grid gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Supporting files</h2>
          <p className="text-xs text-muted-foreground">
            Text files under references, scripts, assets, or templates.
          </p>
        </div>
        {!disabled && (
          <Button type="button" variant="outline" size="sm" onClick={addFile}>
            <FilePlus2 className="size-4" /> Add file
          </Button>
        )}
      </div>
      <div className="grid min-h-80 overflow-hidden rounded-md border md:grid-cols-[14rem_1fr]">
        <div className="border-b bg-secondary/30 p-2 md:border-r md:border-b-0">
          {files.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">No files added.</p>
          ) : (
            files.map((file) => (
              <button
                type="button"
                key={file.path}
                onClick={() => setSelectedPath(file.path)}
                className={`block w-full truncate rounded px-3 py-2 text-left text-xs ${
                  selectedPath === file.path
                    ? "bg-input text-foreground"
                    : "text-muted-foreground hover:bg-input/60"
                }`}
              >
                {file.path}
              </button>
            ))
          )}
        </div>
        <div className="grid content-start gap-3 p-4">
          {selected ? (
            <>
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="skill-file-path">Path</Label>
                  {!disabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 hover:text-destructive"
                      onClick={deleteFile}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Delete file</span>
                    </Button>
                  )}
                </div>
                <Input
                  id="skill-file-path"
                  key={selected.path}
                  defaultValue={selected.path}
                  disabled={disabled}
                  readOnly={disabled}
                  onBlur={(event) => renameFile(event.target.value.trim())}
                />
              </div>
              <Textarea
                aria-label={`${selected.path} content`}
                value={selected.content}
                disabled={disabled}
                readOnly={disabled}
                className="min-h-56 resize-y font-mono text-sm"
                onChange={(event) =>
                  onChange(
                    files.map((file) =>
                      file.path === selected.path
                        ? {
                            ...file,
                            content: event.target.value,
                            size: new TextEncoder().encode(event.target.value)
                              .byteLength,
                          }
                        : file,
                    ),
                  )
                }
              />
            </>
          ) : (
            <p className="self-center text-center text-sm text-muted-foreground">
              Select a file to edit it.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
