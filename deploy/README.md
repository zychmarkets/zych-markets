# ZYCH Markets single-VPS runbook

This is a deployment template, not evidence that a VPS has been configured. Use a supported Linux LTS, Node.js 22 or newer, systemd, and Caddy. Keep the Node service private on `127.0.0.1:4178`; only SSH, HTTP, and HTTPS should be public.

## Host and service user

Create a non-root `zych` service user with SSH key access. Keep SSH on port 22 initially, verify key login in a second session, validate SSH configuration with `sshd -t`, and only then disable password authentication and direct root password login. Allow inbound TCP 22, 80, and 443 for both IPv4 and IPv6; deny other unsolicited inbound traffic. Do not restrict outbound DNS or HTTPS/WSS exchange traffic.

Create the layout with appropriately privileged commands:

```sh
sudo install -d -o zych -g zych -m 0750 /opt/zych-markets/releases
sudo install -d -o zych -g zych -m 0700 /var/lib/zych-markets
sudo install -d -o root -g zych -m 0750 /etc/zych-markets
```

Each verified checkout belongs in `/opt/zych-markets/releases/<git-sha>`. Install the pinned dependencies in that directory with `pnpm install --frozen-lockfile --prod` after installing a pinned pnpm release through Corepack. Confirm the actual Node executable path with `command -v node` and adjust `ExecStart` in the service template if it is not `/usr/bin/node`.

Before activation, run `pnpm install --frozen-lockfile` and `pnpm test` in the candidate release. Production releases must not contain `.env`, `server-data`, development credentials, or source maps intended only for debugging.

## Configuration and secrets

Copy `deploy/zych.env.example` to `/etc/zych-markets/zych.env`, supply production values outside Git, and protect it:

```sh
sudo chown root:zych /etc/zych-markets/zych.env
sudo chmod 600 /etc/zych-markets/zych.env
```

Never put VAPID private keys, future database passwords, tokens, or session secrets in a release directory or shell history. Back up `/var/lib/zych-markets` only to a protected destination.

## Activate and manage a release

Activate only a tested release using an atomic symlink replacement:

```sh
sudo ln -sfn /opt/zych-markets/releases/<verified-git-sha> /opt/zych-markets/current
sudo install -o root -g root -m 0644 deploy/zych-markets.service /etc/systemd/system/zych-markets.service
sudo systemctl daemon-reload
sudo systemctl enable --now zych-markets
sudo systemctl status zych-markets
sudo journalctl -u zych-markets -f
```

Use `sudo systemctl restart zych-markets` for a graceful restart. `systemctl stop` sends SIGTERM and the application applies its bounded shutdown. Verify automatic startup with a planned reboot only after SSH, firewall, and provider console recovery access are confirmed.

Rollback by repointing `/opt/zych-markets/current` to the previous verified release and restarting the service. Do not delete the previous release until the replacement has passed verification.

## Caddy, DNS, and HTTPS

DNS must point the chosen hostname, normally `app.zych.markets`, to the VPS before certificate issuance. Install Caddy from its supported distribution source, copy `deploy/Caddyfile`, and provide `ZYCH_HOSTNAME` and `ACME_EMAIL` in Caddy's service environment. Validate before reload:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy terminates HTTPS and proxies to loopback. It supports WebSocket upgrades and streams future SSE responses without an application-specific buffering layer. Add HSTS only after the domain and HTTPS operation have been proven stable.

## Verification and operations

From outside the host, verify HTTPS and public health:

```sh
curl --fail https://app.zych.markets/health/live
curl --fail https://app.zych.markets/health/ready
```

Readiness may return 503 during safe Radar warm-up. Detailed Radar diagnostics are intentionally unavailable through Caddy. Access them through an SSH tunnel or directly on the host:

```sh
curl --fail http://127.0.0.1:4178/api/radar/health
```

Confirm that the public network cannot connect to port 4178 and that private paths such as `/.env`, `/server/index.js`, and `/package.json` return 404. Review journald for startup, readiness, exchange reconnect, recovery, fatal error, and shutdown records. After deployment, verify graceful restart, reboot startup, HTTPS, liveness, readiness, exchange connectivity, and stable resource behavior before beginning any separately approved soak.
