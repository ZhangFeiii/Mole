export type MaintenanceKind = "cleanup" | "applications" | "optimize" | "files";
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
  path?: string;
  groupId?: string;
  groupName?: string;
  category?: string;
  recommended?: boolean;
  recommendation?: string;
  running?: boolean | null;
  knownProcessNames?: string[];
  scope?: string;
  source?: string;
}
export interface MaintenancePlan {
  id: string;
  createdAt?: string | number;
  expiresAt?: string | number;
  items: MaintenanceItem[];
  warnings?: string[];
  groups?: {
    id: string;
    name: string;
    count?: number;
    bytes?: number;
    partial?: boolean;
  }[];
  partial?: boolean;
  hasMore?: boolean;
  nextCursor?: string | null;
  totalObserved?: number;
}
export interface MaintenanceProgress {
  id: string;
  kind: MaintenanceKind | "recovery" | "protection";
  phase: "preview" | "confirm" | "execute" | "idle";
  cancelled?: boolean;
  completed?: number;
  total?: number;
  visited?: number;
  files?: number;
  items?: number;
  bytes?: number;
  found?: number;
  scanned?: number;
  currentName?: string;
  message?: string;
}
export interface RecoveryState {
  required: boolean;
  corrupt: boolean;
  reason: string;
  active: {
    id: string;
    kind: MaintenanceKind;
    startedAt?: string;
    count?: number;
    names?: string[];
  } | null;
  history: {
    id: string;
    kind: string;
    at: string;
    status: string;
    count: number;
    names?: string[];
    counts?: Record<string, number>;
  }[];
  cancelled?: boolean;
}
export interface MaintenanceWorkspace {
  plan?: MaintenancePlan;
  result?: MaintenanceResult;
  error?: string;
  operation?: MaintenanceProgress | null;
}
export interface ProtectedItem {
  id: string;
  path: string;
  createdAt?: string;
  source?: string;
  removable?: boolean;
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
  summary?: {
    requested: number;
    completed: number;
    skipped: number;
    failed: number;
    unknown: number;
    bytesMoved: number | null;
  };
}
