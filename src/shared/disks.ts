export interface Disk {
  id: string;
  name: string;
  status: 'creating' | 'ready' | 'failed' | 'deleting' | 'deleted';
  sourceMode: 'fixture' | 'real';
  createdAt: string;
  updatedAt: string;
  cleanupPending: boolean;
  failureReason: string | null;
  workspaceCount: number;
  attachmentCount: number;
  canDelete: boolean;
}
export interface DiskWorkspace {
  id: string;
  diskId: string;
  name: string;
  repositoryUrl: string;
  commitSha: string;
  initialized: boolean;
  activeTaskId: string | null;
  status: 'available' | 'in_use';
  createdAt: string;
  updatedAt: string;
}
export interface DiskAttachment {
  vmId: string;
  environmentId: string | null;
  status: string;
  generation: string | null;
  provider: string;
  vmName: string;
  createdAt: string;
}
export interface DiskDetail {
  disk: Disk;
  workspaces: DiskWorkspace[];
  attachments: DiskAttachment[];
}
export interface DiskOptions {
  enabled: boolean;
  mode: 'fixture' | 'real';
  eligibleCatalogIds: string[];
}
export interface DiskFileEntry {
  key: string;
  name: string;
  kind: 'directory' | 'file';
  size?: number;
}
export interface DiskFilePage {
  prefix: string;
  entries: DiskFileEntry[];
  nextContinuationToken?: string;
}
export interface DiskFilePreview {
  key: string;
  size: number;
  content: string | null;
  truncated: boolean;
  binary: boolean;
}
