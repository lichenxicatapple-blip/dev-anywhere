# Deploy DEV Anywhere

This guide covers the hosted path: a VPS runs the relay and web client, while each developer runs the local proxy on their own machine.

## Prerequisites

- A Linux VPS. Ubuntu 22.04 LTS or 24.04 LTS is the recommended path.
- A DNS name pointing at the VPS, for example `dev-anywhere.example.com`.
- Public inbound TCP ports `80` and `443`.
- SSH access to the VPS with a user that can run `sudo`.
- Outbound HTTPS access from the VPS so it can install packages, request Let's Encrypt certificates, and pull Docker images.
- Docker Compose v2 on the VPS, or permission for the installer to install Docker.
- Node.js 20+ on each developer machine.
- Claude Code or Codex installed locally on each developer machine.

## VPS Checklist

Before running the installer:

1. Create an Ubuntu 22.04/24.04 VPS with at least 1 vCPU, 1 GB RAM, and a few GB of free disk.
2. Add an `A` record such as `dev-anywhere.example.com -> <VPS public IPv4>`.
3. Confirm DNS has propagated:

```bash
dig +short dev-anywhere.example.com
```

4. Open ports `80/tcp` and `443/tcp` in the cloud firewall/security group.
5. If the VPS uses UFW, allow SSH, HTTP, and HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

6. Confirm your SSH user can run `sudo`:

```bash
ssh ubuntu@dev-anywhere.example.com 'sudo -v'
```

The installer can install Docker and certbot on apt/yum based distributions. If you prefer to install them yourself, make sure `docker compose version` and `certbot --version` work before deployment.

The default image registry is the public Aliyun ACR mirror used by this project. If you want GHCR instead, pass `REGISTRY_BASE=ghcr.io/lichenxicatapple-blip` when running the installer.

## 1. Deploy Relay and Web

From your laptop:

```bash
IMAGE_TAG=0.1.1 ./scripts/install-relay.sh --ssh ubuntu@dev-anywhere.example.com dev-anywhere.example.com
```

Or run directly on the VPS:

```bash
sudo env IMAGE_TAG=0.1.1 ./scripts/install-relay.sh dev-anywhere.example.com
```

The installer creates `/opt/dev-anywhere/docker-compose.yml`, obtains a TLS certificate, writes `/opt/dev-anywhere/.env`, pulls the published images, and starts:

- `dev-anywhere-relay`
- `dev-anywhere-nginx`

The final output includes:

- Web UI URL: `https://dev-anywhere.example.com/?relayToken=<RELAY_CLIENT_TOKEN>`
- Proxy WebSocket URL: `wss://dev-anywhere.example.com/proxy?token=<RELAY_PROXY_TOKEN>`
- Client WebSocket URL: `wss://dev-anywhere.example.com/client?token=<RELAY_CLIENT_TOKEN>`

Keep both tokens private. `RELAY_PROXY_TOKEN` is for local proxy daemons. `RELAY_CLIENT_TOKEN` is for browsers and PWAs.

## 2. Configure a Developer Machine

Install the proxy:

```bash
npm install -g @dev-anywhere/proxy
dev-anywhere init
```

Edit `~/.dev-anywhere/config.json`:

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "relay": "cloud"
    }
  },
  "relays": {
    "cloud": {
      "url": "wss://dev-anywhere.example.com",
      "proxyToken": "<RELAY_PROXY_TOKEN>"
    }
  }
}
```

Start the daemon:

```bash
dev-anywhere serve start --relay cloud
dev-anywhere serve status
```

## 3. Open the Client

Open the Web UI URL printed by the installer:

```text
https://dev-anywhere.example.com/?relayToken=<RELAY_CLIENT_TOKEN>
```

The browser stores the client token in local browser storage for future launches. On iOS or iPadOS, use Safari's **Add to Home Screen** action to install it as a PWA.

For a step-by-step PWA guide, see [Install the PWA](PWA.md).

## 4. Start Sessions

From any project directory on the developer machine:

```bash
dev-anywhere claude
dev-anywhere codex
```

Then open the web client, choose the connected machine, and create or resume a session.

## Operations

Upgrade to a new published image tag:

```bash
sudo env IMAGE_TAG=0.1.1 ./scripts/install-relay.sh dev-anywhere.example.com
```

Check service health:

```bash
curl -fsS https://dev-anywhere.example.com/health
ssh ubuntu@dev-anywhere.example.com 'cd /opt/dev-anywhere && sudo docker compose ps'
```

Rotate tokens by editing `/opt/dev-anywhere/.env` and restarting:

```bash
cd /opt/dev-anywhere
sudo editor .env
sudo docker compose up -d
```

After rotating `RELAY_PROXY_TOKEN`, update each developer's `~/.dev-anywhere/config.json`. After rotating `RELAY_CLIENT_TOKEN`, reopen the web app with the new `?relayToken=...` URL.

## Security Notes

- Always use TLS for public deployments.
- Always set both `RELAY_PROXY_TOKEN` and `RELAY_CLIENT_TOKEN`.
- Do not put repository credentials or AI provider credentials on the VPS.
- The relay should route traffic only; the local proxy owns CLI processes and repository access.
