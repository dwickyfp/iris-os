"use client";

import { Input } from "ui/input";
import { Label } from "ui/label";
import { Textarea } from "ui/textarea";

interface SkillMetadataEditorProps {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  disabled?: boolean;
  onChange: (value: {
    name?: string;
    description?: string;
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    allowedTools?: string[];
  }) => void;
}

export function SkillMetadataEditor({
  name,
  description,
  license,
  compatibility,
  metadata,
  allowedTools,
  disabled,
  onChange,
}: SkillMetadataEditorProps) {
  const metadataText = Object.entries(metadata ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="skill-name">Name</Label>
        <Input
          id="skill-name"
          value={name}
          maxLength={100}
          disabled={disabled}
          readOnly={disabled}
          placeholder="A short, descriptive skill name"
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="skill-description">Description</Label>
        <Textarea
          id="skill-description"
          value={description}
          maxLength={8000}
          disabled={disabled}
          readOnly={disabled}
          className="min-h-24 resize-y"
          placeholder="Explain when this skill should be used"
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="skill-license">License</Label>
          <Input
            id="skill-license"
            value={license ?? ""}
            disabled={disabled}
            readOnly={disabled}
            placeholder="MIT"
            onChange={(event) => onChange({ license: event.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="skill-tools">Allowed tools</Label>
          <Input
            id="skill-tools"
            value={(allowedTools ?? []).join(", ")}
            disabled={disabled}
            readOnly={disabled}
            placeholder="tool-one, tool-two"
            onChange={(event) =>
              onChange({
                allowedTools: event.target.value
                  .split(",")
                  .map((tool) => tool.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="skill-compatibility">Compatibility</Label>
        <Input
          id="skill-compatibility"
          value={compatibility ?? ""}
          disabled={disabled}
          readOnly={disabled}
          placeholder="Runtime or environment requirements"
          onChange={(event) => onChange({ compatibility: event.target.value })}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="skill-metadata">Metadata</Label>
        <Textarea
          id="skill-metadata"
          key={metadataText}
          defaultValue={metadataText}
          disabled={disabled}
          readOnly={disabled}
          className="min-h-24 font-mono text-sm"
          placeholder={"author=Example\nversion=1.0"}
          onBlur={(event) => {
            const entries = event.target.value
              .split("\n")
              .map((line) => line.split("="))
              .filter(([key, ...value]) => key?.trim() && value.length > 0)
              .map(([key, ...value]) => [key.trim(), value.join("=").trim()]);
            onChange({ metadata: Object.fromEntries(entries) });
          }}
        />
        <p className="text-xs text-muted-foreground">
          One key=value pair per line.
        </p>
      </div>
    </div>
  );
}
