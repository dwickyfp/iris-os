export type CapabilityHealthStatus =
  | "healthy"
  | "degraded"
  | "auth_required"
  | "unavailable"
  | "disabled";

export type CapabilityHealth = {
  status: CapabilityHealthStatus;
  reason?: string;
  checkedAt?: string;
  metadata?: Record<string, unknown>;
};
