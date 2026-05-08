# Security Guide

Remote Agent TUI controls local terminal sessions. Treat access as equivalent to shell access for the service user.

## Supported access modes

### Network/LAN/Tailscale mode

```env
BIND_HOST=0.0.0.0
AUTH_TOKEN=<strong-random-token>
```

Network binds require a strong `AUTH_TOKEN`. The server refuses to start with an empty or weak token when bound to a network-reachable address.

Use this only on trusted LANs, VPNs, or Tailscale/WireGuard networks.

### Local-only mode

```env
BIND_HOST=127.0.0.1
AUTH_TOKEN=
```

No-auth mode is allowed only for loopback/local tunnel use. For remote access, prefer SSH port forwarding:

```bash
ssh -L 5555:localhost:5555 user@host
```

Then open `http://localhost:5555` locally.

### Exposed/shared deployments

For shared or untrusted networks, put Remote Agent TUI behind a TLS reverse proxy or identity-aware proxy such as Authelia, OAuth2 Proxy, Tailscale Serve, or an OIDC-capable gateway.

Ensure WebSocket upgrades are forwarded for `/ws`.

## HTTP limitations

Remote Agent TUI supports HTTP by default for local/trusted-network use. Plain HTTP does not protect traffic from network attackers.

On plain HTTP, an attacker on the network path can read or modify:

- `AUTH_TOKEN`
- terminal input/output
- WebSocket frames
- future MFA codes or session tokens

`AUTH_TOKEN` protects application access, not transport confidentiality. Use localhost tunnels, Tailscale/WireGuard, or HTTPS for transport security.

## Browser token storage

The browser stores the token locally for convenience. This can be read by malicious browser extensions or successful XSS. Security headers reduce XSS blast radius, but do not protect against compromised browsers or HTTP sniffing.

## MFA status

App-native 2FA is not enabled yet.

Recommended strong-auth options today:

- SSH tunnel + local bind
- Tailscale/WireGuard ACLs
- HTTPS reverse proxy with OIDC/Authelia/IdP MFA

Future app-native TOTP should be used only with trusted transport or HTTPS. TOTP over plain HTTP does not stop network interception.
