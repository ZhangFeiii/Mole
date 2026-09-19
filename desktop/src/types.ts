import type {
  MaintenanceKind,
  MaintenancePlan,
  MaintenanceResult,
  MaintenanceWorkspace,
  MaintenanceProgress,
  RecoveryState,
  ProtectedItem,
} from "./maintenanceTypes";

export interface Entry {
  name: string;
  path: string;
  size: number;
  directory: boolean;
  modified: string;
  entryId?: string;
  trashable?: boolean;
}
export interface ScanResult {
  root: string;
  bytes: number;
  files: number;
  directories: number;
  entryCount: number;
  entries: Entry[];
  largeFiles: Entry[];
  skipped: Record<string, number>;
  partial: boolean;
  cancelled: boolean;
  limitReached: boolean;
  elapsedMs: number;
}
export interface Volume {
  path: string;
  filesystem: string;
  total: number;
  used: number;
  free: number;
}
export interface Metrics {
  collectedAt: number;
  platform: string;
  os: string;
  hostname: string;
  uptime: number;
  cpuModel: string;
  cores: number;
  cpuPercent: number | null;
  memoryTotal: number;
  memoryUsed: number;
  memoryPercent: number | null;
  networkSent: number | null;
  networkReceived: number | null;
  volumes: Volume[];
  warnings: string[];
  processes?: {
    topCpu: ProcessMetric[];
    topMemory: ProcessMetric[];
  };
  diskIO?: {
    name: string;
    readBytes: number | null;
    writeBytes: number | null;
    readCount?: number | null;
    writeCount?: number | null;
    readBytesPerSecond?: number | null;
    writeBytesPerSecond?: number | null;
  }[];
  battery?: {
    percent: number | null;
    charging: boolean | null;
    timeRemainingSeconds: number | null;
    source?: string;
  } | null;
  gpu?: {
    name: string | null;
    vendor?: string | null;
    memoryBytes: number | null;
    utilizationPercent: number | null;
    source?: string;
  }[];
}
export interface ProcessMetric {
  pid: number;
  name: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  status?: string | null;
}
export interface Bootstrap {
  home: string;
  platform: string;
  version: string;
  readOnly: boolean;
  maintenance: boolean;
}
export interface MoleBridge {
  bootstrap(): Promise<Bootstrap>;
  chooseDirectory(): Promise<string | null>;
  status(): Promise<Metrics>;
  scan(root: string, id: string): Promise<ScanResult | { cancelled: true }>;
  cancel(id: string): Promise<void>;
  reveal(path: string): Promise<void>;
  trashAnalysisEntry(entryId: string): Promise<MaintenanceResult>;
  maintenancePreview(
    kind: MaintenanceKind,
    options?: { cursor?: string; selectionIds?: string[] },
  ): Promise<MaintenancePlan | { cancelled: true }>;
  maintenanceExecute(
    kind: MaintenanceKind,
    planId: string,
    selectedIds: string[],
  ): Promise<MaintenanceResult>;
  maintenanceWorkspace(kind: MaintenanceKind): Promise<MaintenanceWorkspace>;
  maintenanceState(): Promise<{
    recovery: RecoveryState;
    operation: MaintenanceProgress | null;
  }>;
  maintenanceCancel(kind?: MaintenanceProgress["kind"]): Promise<boolean>;
  maintenanceRecover(): Promise<RecoveryState>;
  protect(planId: string, itemId: string): Promise<unknown>;
  protectedItems(): Promise<ProtectedItem[]>;
  unprotect(id: string): Promise<{ removed?: boolean; cancelled?: boolean }>;
  systemPage(
    page: "storage" | "applications" | "startup" | "updates",
  ): Promise<void>;
  onMaintenanceProgress(
    callback: (event: MaintenanceProgress) => void,
  ): () => void;
  onProgress(
    callback: (event: { id: string; data: ScanResult }) => void,
  ): () => void;
}
declare global {
  interface Window {
    mole?: MoleBridge;
  }
}
