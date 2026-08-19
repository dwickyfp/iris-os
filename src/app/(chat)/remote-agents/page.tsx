import { RemoteAgentConnections } from "@/components/remote-agent/remote-agent-connections";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { notFound } from "next/navigation";

export default function RemoteAgentsPage() {
  if (!isV2FeatureEnabled("remoteAgents")) notFound();
  return <RemoteAgentConnections />;
}
