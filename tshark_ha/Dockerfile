ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM $BUILD_FROM

# Install runtime dependencies
RUN apk add --no-cache \
    tshark \
    tcpdump \
    nodejs \
    npm \
    bash \
    iproute2 \
    libcap

# Allow tshark to capture without full root (belt-and-suspenders, container still runs privileged)
RUN setcap cap_net_raw,cap_net_admin=eip /usr/bin/dumpcap || true

WORKDIR /app

# Copy package files first for layer caching
COPY app/package*.json ./

RUN npm ci --omit=dev

# Copy application source
COPY app/ .

# Copy the startup script
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]

LABEL \
    io.hass.name="tshark Network Analyzer" \
    io.hass.description="Live packet capture and traffic visualization" \
    io.hass.version="1.0.0" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64|armv7"
