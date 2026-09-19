export interface Entry {
  name: string;
  path: string;
  size: number;
  directory: boolean;
  modified: string;
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
}
export interface Bootstrap {
  home: string;
  platform: string;
  version: string;
  readOnly: true;
}
export interface MoleBridge {
  bootstrap(): Promise<Bootstrap>;
  chooseDirectory(): Promise<string | null>;
  status(): Promise<Metrics>;
  scan(root: string, id: string): Promise<ScanResult | { cancelled: true }>;
  cancel(id: string): Promise<void>;
  reveal(path: string): Promise<void>;
  onProgress(
    callback: (event: { id: string; data: ScanResult }) => void,
  ): () => void;
}
declare global {
  interface Window {
    mole?: MoleBridge;
  }
}
