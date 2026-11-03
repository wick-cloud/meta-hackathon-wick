-- One network (for example a venue Wi-Fi) may now run several demos at once.
-- Admission counts a network's active and cooling-down runs under the
-- homepage-demo-admission advisory lock; each browser keeps one active run.
DROP INDEX broker_demo_runs_one_ip_idx;
