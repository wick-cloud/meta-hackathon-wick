CREATE TABLE broker_demo_disk_pool (
 source_mode text NOT NULL CHECK(source_mode IN('real','fixture')),
 slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 2),
 owner_id text NOT NULL REFERENCES "user"(id),
 disk_id uuid UNIQUE REFERENCES broker_disks(id),
 run_id uuid UNIQUE REFERENCES broker_demo_runs(id),
 PRIMARY KEY(source_mode,slot)
);
ALTER TABLE broker_demo_runs ADD COLUMN reusable_disk boolean NOT NULL DEFAULT false;
