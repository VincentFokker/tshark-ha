#!/usr/bin/with-contenv bashio

bashio::log.info "Starting Dagster..."

LOG_LEVEL=$(bashio::config 'log_level')
PG_HOST=$(bashio::config 'postgres_host')
PG_PORT=$(bashio::config 'postgres_port')
PG_USER=$(bashio::config 'postgres_username')
PG_PASS=$(bashio::config 'postgres_password')
PG_DB=$(bashio::config 'postgres_database')

# Ensure dagster home directories exist
mkdir -p "${DAGSTER_HOME}/artifacts"
mkdir -p "${DAGSTER_HOME}/logs"

# Always write dagster.yaml from current config so changes take effect on restart
bashio::log.info "Configuring Dagster with PostgreSQL backend (${PG_HOST}:${PG_PORT}/${PG_DB})..."
cat > "${DAGSTER_HOME}/dagster.yaml" <<EOF
telemetry:
  enabled: false

storage:
  postgres:
    postgres_db:
      username: ${PG_USER}
      password: ${PG_PASS}
      hostname: ${PG_HOST}
      port: ${PG_PORT}
      db_name: ${PG_DB}

local_artifact_storage:
  module: dagster.core.storage.root
  class: LocalArtifactStorage
  config:
    base_dir: ${DAGSTER_HOME}/artifacts

compute_logs:
  module: dagster.core.storage.local_compute_log_manager
  class: LocalComputeLogManager
  config:
    base_dir: ${DAGSTER_HOME}/logs
EOF

# Copy default workspace on first run
if [ ! -f "${DAGSTER_HOME}/workspace.yaml" ]; then
    bashio::log.info "Initializing workspace config..."
    cp /etc/dagster/workspace.yaml "${DAGSTER_HOME}/workspace.yaml"
fi

bashio::log.info "Starting Dagster webserver on port 3000 (log level: ${LOG_LEVEL})..."

exec dagster-webserver \
    --host 0.0.0.0 \
    --port 3000 \
    --workspace "${DAGSTER_HOME}/workspace.yaml" \
    --log-level "$(echo "${LOG_LEVEL}" | tr '[:upper:]' '[:lower:]')"
