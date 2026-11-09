import os

# Motor runs every MongoDB call on a thread pool sized cpu_count * 5 (10 threads on the 2-vCPU API host),
# so no more than 10 database calls are ever in flight: a few people opening the dashboard at once queued
# behind each other there (perf/scale: 10 at once, p50 710 ms with 10 threads, 423 ms with 40). Set before
# anything imports motor; MOTOR_MAX_WORKERS in the environment still wins.
os.environ.setdefault("MOTOR_MAX_WORKERS", "32")
