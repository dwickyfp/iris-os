import { LearningInbox } from "@/components/learning/learning-inbox";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { notFound } from "next/navigation";

export default function LearningPage() {
  if (!isV2FeatureEnabled("learning")) notFound();
  return <LearningInbox />;
}
