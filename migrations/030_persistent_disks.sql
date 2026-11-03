CREATE TABLE broker_disks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id text NOT NULL REFERENCES "user"(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), source_mode text NOT NULL CHECK(source_mode IN('fixture','real')),
 status text NOT NULL DEFAULT 'creating' CHECK(status IN('creating','ready','failed','deleting','deleted')),
 upstream_id text UNIQUE, create_key text NOT NULL UNIQUE, delete_key text UNIQUE, upstream_operation_id text,
 cleanup_pending boolean NOT NULL DEFAULT false, failure_reason text,
 lease_token uuid, needs_sync boolean NOT NULL DEFAULT false, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX broker_disk_owner_page ON broker_disks(buyer_id,created_at DESC,id DESC);
CREATE INDEX broker_disk_reconcile ON broker_disks(updated_at,id) WHERE status IN('creating','deleting') OR needs_sync;
ALTER TABLE broker_requests ADD COLUMN disk_id uuid REFERENCES broker_disks(id);
ALTER TABLE broker_vms ADD COLUMN disk_id uuid REFERENCES broker_disks(id);
CREATE INDEX broker_request_disk ON broker_requests(disk_id,status) WHERE disk_id IS NOT NULL;
CREATE INDEX broker_vm_disk ON broker_vms(disk_id) WHERE cleanup_confirmed_at IS NULL;
CREATE TABLE broker_disk_attachments (
 disk_id uuid NOT NULL REFERENCES broker_disks(id), vm_id uuid PRIMARY KEY REFERENCES broker_vms(id),
 environment_id text, generation text, status text NOT NULL DEFAULT 'reserved',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX broker_disk_attachment_active ON broker_disk_attachments(disk_id,created_at,vm_id) WHERE status<>'detached';
CREATE TABLE broker_disk_workspaces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), disk_id uuid NOT NULL REFERENCES broker_disks(id),
 buyer_id text NOT NULL REFERENCES "user"(id), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 repository_url text NOT NULL, commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
 initialized boolean NOT NULL DEFAULT false, active_task_id uuid REFERENCES broker_studio_tasks(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX broker_disk_workspace_page ON broker_disk_workspaces(disk_id,created_at,id);
CREATE FUNCTION broker_immutable_disk_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.disk_id IS DISTINCT FROM OLD.disk_id THEN RAISE EXCEPTION 'Disk selection is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER broker_request_disk_immutable BEFORE UPDATE ON broker_requests FOR EACH ROW EXECUTE FUNCTION broker_immutable_disk_selection();
CREATE TRIGGER broker_vm_disk_immutable BEFORE UPDATE ON broker_vms FOR EACH ROW EXECUTE FUNCTION broker_immutable_disk_selection();
-- Explicit simulation state; fixture files never stand in for a failed real call.
CREATE TABLE broker_fixture_drives (
 id text PRIMARY KEY, create_key text NOT NULL UNIQUE, name text NOT NULL, status text NOT NULL DEFAULT 'ready',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE broker_fixture_drive_files (
 drive_id text NOT NULL REFERENCES broker_fixture_drives(id), key text NOT NULL, content_base64 text NOT NULL,
 PRIMARY KEY(drive_id,key)
);
