export type MaintenanceKind = "cleanup" | "applications" | "optimize";
export interface MaintenanceItem {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  reason?: string;
  publisher?: string;
  version?: string;
  size?: number;
  sizeBytes?: number;
  requiresAdmin?: boolean;
  requiresElevation?: boolean;
  impact?: string;
}
export interface MaintenancePlan {
  id: string;
  createdAt?: string | number;
  expiresAt?: string | number;
  items: MaintenanceItem[];
  warnings?: string[];
}
export interface MaintenanceResult {
  cancelled?: boolean;
  results: {
    id: string;
    name?: string;
    status: string;
    message?: string;
    drives?: { driveLetter: string; status: string; message?: string }[];
  }[];
  warnings?: string[];
}
