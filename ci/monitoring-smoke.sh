#!/bin/sh
set -eu
# Isolated fictional records, ephemeral volumes/network; never touches a live collector.
cd "$(dirname "$0")/.."
monitor_id="decaid-monitor-$$"
monitor_image="$monitor_id:local"
monitor_network="$monitor_id"
monitor_collector="$monitor_id-collector"
monitor_prom="$monitor_id-prometheus"
monitor_grafana="$monitor_id-grafana"
monitor_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
cleanup() {
  monitor_exit=$?
  if [ "$monitor_exit" -ne 0 ]; then
    docker logs --tail 40 "$monitor_grafana" 2>&1 || true
    docker logs --tail 20 "$monitor_prom" 2>&1 || true
    docker logs --tail 20 "$monitor_collector" 2>&1 || true
  fi
  docker rm -f -v "$monitor_grafana" "$monitor_prom" "$monitor_collector" >/dev/null 2>&1 || true
  docker network rm "$monitor_network" >/dev/null 2>&1 || true
  docker image rm "$monitor_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
monitor_root=$(pwd)
docker build -q -t "$monitor_image" -f collector/Dockerfile .
docker network create "$monitor_network" >/dev/null
docker run --rm --entrypoint /bin/promtool -v "$monitor_root/collector/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro" prom/prometheus:v3.13.4 check config /etc/prometheus/prometheus.yml
docker run -d --name "$monitor_collector" --network "$monitor_network" --network-alias collector --read-only --cap-drop ALL --security-opt no-new-privileges -v /var/lib/research -p 127.0.0.1::8787 -e RESEARCH_METRICS_PORT=8788 -e RESEARCH_METRICS_BIND_HOST=0.0.0.0 "$monitor_image" >/dev/null
docker run -d --name "$monitor_prom" --network "$monitor_network" --network-alias prometheus -p 127.0.0.1::9090 -v "$monitor_root/collector/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro" prom/prometheus:v3.13.4 --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.retention.time=1h >/dev/null
docker run -d --name "$monitor_grafana" --network "$monitor_network" -p 127.0.0.1::3000 -e GF_SECURITY_ADMIN_PASSWORD="$monitor_password" -e GF_ANALYTICS_REPORTING_ENABLED=false -e GF_ANALYTICS_CHECK_FOR_UPDATES=false -e GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false -e GF_USERS_ALLOW_SIGN_UP=false -e GF_AUTH_ANONYMOUS_ENABLED=false -v "$monitor_root/collector/monitoring/grafana/provisioning:/etc/grafana/provisioning:ro" -v "$monitor_root/collector/monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro" grafana/grafana:12.4.12 >/dev/null
MONITOR_COLLECTOR_URL="http://$(docker port "$monitor_collector" 8787/tcp)" \
MONITOR_PROMETHEUS_URL="http://$(docker port "$monitor_prom" 9090/tcp)" \
MONITOR_GRAFANA_URL="http://$(docker port "$monitor_grafana" 3000/tcp)" \
MONITOR_GRAFANA_PASSWORD="$monitor_password" \
node ci/monitoring-smoke.js
