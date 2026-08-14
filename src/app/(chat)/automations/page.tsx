import { AutomationOperations } from "@/components/os/automation-operations";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { notFound } from "next/navigation";

export default function AutomationsPage() {
  if (!isV2FeatureEnabled("automation")) notFound();
  return <AutomationOperations />;
}
