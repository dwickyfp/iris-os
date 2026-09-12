import { BlendIcon } from "lucide-react";
import { ClaudeIcon } from "./claude-icon";
import { GeminiIcon } from "./gemini-icon";
import { GrokIcon } from "./grok-icon";
import { OllamaIcon } from "./ollama-icon";
import { OpenRouterIcon } from "./open-router-icon";
import { OpenAIIcon } from "./openai-icon";

export function ModelProviderIcon({
  provider,
  className,
}: { provider: string; className?: string }) {
  return provider === "openai" ? (
    <OpenAIIcon className={className} />
  ) : provider === "xai" ? (
    <GrokIcon className={className} />
  ) : provider === "anthropic" ? (
    <ClaudeIcon className={className} />
  ) : provider === "google" ? (
    <GeminiIcon className={className} />
  ) : provider === "ollama" ? (
    <OllamaIcon className={className} />
  ) : provider === "openrouter" || provider === "openRouter" ? (
    <OpenRouterIcon className={className} />
  ) : (
    <BlendIcon className={className} />
  );
}
