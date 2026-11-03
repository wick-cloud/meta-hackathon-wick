-- Disk bytes outlive task artifacts; command and funding authority stays in Postgres.
ALTER TABLE broker_studio_tasks ADD COLUMN disk_id uuid REFERENCES broker_disks(id);
ALTER TABLE broker_studio_tasks ADD COLUMN workspace_id uuid REFERENCES broker_disk_workspaces(id);
ALTER TABLE broker_studio_tasks ADD COLUMN continuing_workspace boolean NOT NULL DEFAULT false;
ALTER TABLE broker_studio_tasks ADD CONSTRAINT broker_studio_workspace_selection CHECK ((disk_id IS NULL)=(workspace_id IS NULL));
ALTER TABLE broker_coding_jobs ADD COLUMN disk_id uuid REFERENCES broker_disks(id);
ALTER TABLE broker_coding_jobs ADD COLUMN workspace_id uuid REFERENCES broker_disk_workspaces(id);
ALTER TABLE broker_coding_jobs ADD COLUMN disk_generation text;
ALTER TABLE broker_coding_jobs ADD COLUMN continuing_workspace boolean NOT NULL DEFAULT false;
ALTER TABLE broker_coding_jobs ADD CONSTRAINT broker_coding_workspace_selection CHECK ((disk_id IS NULL)=(workspace_id IS NULL));
CREATE INDEX broker_studio_workspace_history ON broker_studio_tasks(workspace_id,created_at DESC,id DESC) WHERE workspace_id IS NOT NULL;
