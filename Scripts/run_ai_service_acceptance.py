#!/usr/bin/env python3
"""Run disposable real-service acceptance; never target existing application databases.

No real model or remote Git/cloud account is used. Requires Docker, Cargo and local
postgres:17-alpine/mysql:8.4 images. All services are bound to random loopback ports.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "target/ai-acceptance/service-run")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    project = "nodalstudio-ai-acceptance-" + uuid.uuid4().hex[:12]
    compose = ["docker", "compose", "-p", project, "-f", str(ROOT / "infrastructure/docker-compose.ai-acceptance.yml")]
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TEST_", "NODAL_ACCEPTANCE_", "SQLAI_QUERY_TEST_"))}
    results = {"project": project, "checks": {}, "real_model": "not_run", "physical_two_devices": "not_run"}
    server = None
    server_log = None

    def run(name, command, test_count=None, run_env=None):
        print(name, flush=True)
        path = output / f"{name}.log"
        with path.open("w") as log:
            result = subprocess.run(command, cwd=ROOT, env=run_env or env, stdout=log, stderr=subprocess.STDOUT, check=False)
        text = path.read_text()
        passed = result.returncode == 0
        if test_count is not None:
            counts = [int(n) for n in re.findall(r"test result: ok\. (\d+) passed", text)]
            passed = passed and sum(counts) == test_count and "skipping" not in text.lower()
        results["checks"][name] = {"passed": passed, "exit_code": result.returncode, "expected_executed_tests": test_count}
        if not passed:
            raise RuntimeError(f"{name} failed; see {path}")

    def port(service, target):
        value = subprocess.check_output(compose + ["port", service, str(target)], cwd=ROOT, text=True).strip()
        host, value = value.rsplit(":", 1)
        if host != "127.0.0.1":
            raise RuntimeError("acceptance services must be loopback-only")
        return int(value)

    try:
        run("services", compose + ["up", "-d", "--wait", "--pull", "never"])
        pg = f"postgres://nodalstudio:acceptance-fixture-only@127.0.0.1:{port('postgres', 5432)}/nodalstudio_test"
        mysql = f"mysql://nodalstudio:acceptance-fixture-only@127.0.0.1:{port('mysql', 3306)}/nodalstudio_test"
        cloud = f"postgres://nodalstudio:acceptance-fixture-only@127.0.0.1:{port('cloud-db', 5432)}/nodalstudio_cloud_test"
        fixture_env = {**env, "TEST_DATABASE_URL": pg, "TEST_MYSQL_DATABASE_URL": mysql, "TEST_CLOUD_DATABASE_URL": cloud}
        for package, target, name in [("postgres-adapter", "introspection", "postgres-fixture"), ("mysql-adapter", "introspection", "mysql-fixture"), ("nodalstudio-cloud-api", "cloud_workflows", "cloud-database")]:
            run(name, ["cargo", "test", "-p", package, "--test", target, "--", "--nocapture"], 1, fixture_env)
        run("catalog-ai-workflow", ["cargo", "test", "-p", "nodalstudio-desktop", "--lib", "live_acceptance_tests::", "--", "--ignored", "--nocapture", "--test-threads=1"], 2,
            {**env, "NODAL_ACCEPTANCE_POSTGRES_URL": pg, "NODAL_ACCEPTANCE_MYSQL_URL": mysql})
        run("create-http-database", compose + ["exec", "-T", "cloud-db", "psql", "-U", "nodalstudio", "-d", "nodalstudio_cloud_test", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE nodalstudio_cloud_http"])
        run("cloud-build", ["cargo", "build", "-p", "nodalstudio-cloud-api"])
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            http_port = listener.getsockname()[1]
        secret = secrets.token_urlsafe(32)
        server_log = (output / "cloud-server.log").open("w")
        server = subprocess.Popen([str(ROOT / "target/debug/nodalstudio-cloud-api")], cwd=ROOT,
            env={**env, "DATABASE_URL": cloud.replace("/nodalstudio_cloud_test", "/nodalstudio_cloud_http"), "BIND_ADDRESS": f"127.0.0.1:{http_port}", "BOOTSTRAP_SECRET": secret}, stdout=server_log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        while True:
            if server.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("local Cloud HTTP service did not start; see cloud-server.log")
            try:
                with socket.create_connection(("127.0.0.1", http_port), timeout=.2):
                    break
            except OSError:
                time.sleep(.1)
        run("cloud-http-knowledge", ["cargo", "test", "-p", "nodalstudio-desktop", "--lib", "live_cloud_http_preserves_local_review_on_round_trip", "--", "--ignored", "--nocapture"], 1,
            {**env, "NODAL_ACCEPTANCE_CLOUD_URL": f"http://127.0.0.1:{http_port}", "NODAL_ACCEPTANCE_BOOTSTRAP_SECRET": secret})
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
        if server_log is not None:
            server_log.close()
        try:
            run("cleanup", compose + ["down", "--volumes", "--remove-orphans"])
        finally:
            (output / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"Real-service checks passed; evidence: {output}")


if __name__ == "__main__":
    main()
