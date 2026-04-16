#!/usr/bin/with-contenv bashio

bashio::log.info "Starting tshark Network Analyzer..."

# Read user configuration via bashio
export HA_INTERFACE="$(bashio::config 'interface')"
export HA_CAPTURE_FILTER="$(bashio::config 'capture_filter')"
export HA_DISPLAY_FILTER="$(bashio::config 'display_filter')"
export HA_MAX_PACKETS="$(bashio::config 'max_packets')"
export HA_SNAPLEN="$(bashio::config 'snaplen')"
export HA_ROTATE_SECONDS="$(bashio::config 'rotate_seconds')"
export PORT=8099

bashio::log.info "Interface: ${HA_INTERFACE}"
bashio::log.info "Capture filter: ${HA_CAPTURE_FILTER:-<none>}"
bashio::log.info "Max packets in buffer: ${HA_MAX_PACKETS}"

# Verify tshark is available
if command -v tshark &> /dev/null; then
    export CAPTURE_BACKEND="tshark"
    bashio::log.info "Using tshark for packet capture"
else
    export CAPTURE_BACKEND="tcpdump"
    bashio::log.warning "tshark not found, falling back to tcpdump"
fi

exec node /app/server.js
