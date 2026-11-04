-- Match the five-run global admission ceiling without changing existing leases.
ALTER TABLE broker_demo_disk_pool DROP CONSTRAINT broker_demo_disk_pool_slot_check;
ALTER TABLE broker_demo_disk_pool
 ADD CONSTRAINT broker_demo_disk_pool_slot_check CHECK(slot BETWEEN 1 AND 5);
