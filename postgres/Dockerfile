ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache postgresql16 su-exec

# Ensure postgres user/group exists (Alpine postgresql package creates them, but be explicit)
RUN addgroup -S postgres 2>/dev/null || true \
    && adduser -S -D -H -h /var/lib/postgresql -G postgres postgres 2>/dev/null || true

# Register as s6 service
RUN mkdir -p /etc/services.d/postgres
COPY run.sh /etc/services.d/postgres/run
RUN chmod a+x /etc/services.d/postgres/run

LABEL \
    io.hass.name="PostgreSQL" \
    io.hass.description="PostgreSQL relational database server" \
    io.hass.version="1.0.0" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64"
