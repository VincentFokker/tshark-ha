# PostgreSQL add-on

## Connecting from other add-ons

This add-on runs with `host_network: true`, so it binds directly to the
Home Assistant host's network instead of getting its own Supervisor-managed
container hostname. That means the database is always reachable at the
**Home Assistant host's own hostname or IP address** (e.g. `homeassistant.local`
or your instance's LAN IP), on port `5432` — the same address you use to
reach the Home Assistant UI itself.

When configuring another add-on (e.g. Dagster) to connect to this database,
set its `postgres_host` option to that hostname/IP rather than `localhost`
or a container name.
