#!/usr/bin/with-contenv bashio

bashio::log.info "Starting Dagster..."

LOG_LEVEL=$(bashio::config 'log_level')

# Ensure dagster home directories exist
mkdir -p "${DAGSTER_HOME}/storage"
mkdir -p "${DAGSTER_HOME}/artifacts"
mkdir -p "${DAGSTER_HOME}/logs"

# Copy default configs on first run
if [ ! -f "${DAGSTER_HOME}/dagster.yaml" ]; then
    bashio::log.info "Initializing Dagster instance config..."
    cp /etc/dagster/dagster.yaml "${DAGSTER_HOME}/dagster.yaml"
fi

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
