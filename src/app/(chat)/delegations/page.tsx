import { DelegationOperations } from "@/components/os/delegation-operations";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { notFound } from "next/navigation";

export default function DelegationsPage() {
  if (!isV2FeatureEnabled("delegation")) notFound();
  return <DelegationOperations />;
}
