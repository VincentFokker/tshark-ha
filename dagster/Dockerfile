ARG BUILD_FROM
FROM $BUILD_FROM

# Install Python and runtime dependencies, then build deps for pip packages
RUN apk add --no-cache python3 py3-pip \
    && apk add --no-cache --virtual .build-deps \
        gcc \
        musl-dev \
        python3-dev \
        libffi-dev \
        openssl-dev \
        cargo \
    && python3 -m venv /opt/dagster \
    && /opt/dagster/bin/pip install --no-cache-dir \
        dagster \
        dagster-webserver \
    && apk del .build-deps

ENV PATH="/opt/dagster/bin:$PATH"
ENV DAGSTER_HOME=/data/dagster

# Copy default instance and workspace configs
COPY dagster.yaml /etc/dagster/dagster.yaml
COPY workspace.yaml /etc/dagster/workspace.yaml

# Register as s6 service
RUN mkdir -p /etc/services.d/dagster
COPY run.sh /etc/services.d/dagster/run
RUN chmod a+x /etc/services.d/dagster/run

LABEL \
    io.hass.name="Dagster" \
    io.hass.description="Dagster data orchestration platform" \
    io.hass.version="1.0.0" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64"
