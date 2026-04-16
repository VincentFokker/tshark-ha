#!/usr/bin/with-contenv bashio

bashio::log.info "Starting PostgreSQL..."

USERNAME=$(bashio::config 'username')
PASSWORD=$(bashio::config 'password')
DATABASE=$(bashio::config 'database')

DATA_DIR=/data/postgres

# Ensure data directory is owned by postgres user
mkdir -p "${DATA_DIR}"
chown -R postgres:postgres "${DATA_DIR}"
chmod 0700 "${DATA_DIR}"

# Initialize the database cluster if not already done
if [ ! -f "${DATA_DIR}/PG_VERSION" ]; then
    bashio::log.info "Initializing PostgreSQL database cluster..."
    su-exec postgres initdb \
        --pgdata="${DATA_DIR}" \
        --auth-host=md5 \
        --auth-local=trust \
        --encoding=UTF8 \
        --locale=C

    # Allow connections from any host (HA network)
    echo "host all all 0.0.0.0/0 md5" >> "${DATA_DIR}/pg_hba.conf"
    echo "listen_addresses = '*'" >> "${DATA_DIR}/postgresql.conf"

    # Start postgres temporarily to create user and database
    bashio::log.info "Creating user '${USERNAME}' and database '${DATABASE}'..."
    su-exec postgres pg_ctl start -D "${DATA_DIR}" -w -o "-c listen_addresses=''"

    su-exec postgres psql -v ON_ERROR_STOP=1 --username postgres <<-EOSQL
        CREATE USER "${USERNAME}" WITH SUPERUSER PASSWORD '${PASSWORD}';
        CREATE DATABASE "${DATABASE}" OWNER "${USERNAME}";
EOSQL

    su-exec postgres pg_ctl stop -D "${DATA_DIR}" -m fast -w
    bashio::log.info "Database initialized."
fi

bashio::log.info "Starting PostgreSQL on port 5432..."
exec su-exec postgres postgres -D "${DATA_DIR}"
