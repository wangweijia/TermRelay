# Cloudflare Access deployment

TermRelay Web is published at `https://termrelay.wqyhomes.com` through the
existing remotely managed `jetson-invest` Cloudflare Tunnel.

## Traffic paths

- Browsers use Cloudflare Access and Tunnel to reach `http://localhost:3006`
  on the Jetson.
- The Mac App continues to connect directly to the Jetson LAN address at
  `ws://JETSON_LAN_IP:3006/ws/client` and does not traverse Cloudflare.
- The browser derives `wss://termrelay.wqyhomes.com/ws/web` from the page URL.

The planned Mac public-domain pairing and authenticated `/ws/client-public`
connection are documented in
[Mac Client 公网配对与认证方案](CLOUDFLARE_MAC_CLIENT_AUTH.md). The design uses
path-specific Access Bypass rules plus TermRelay-issued device credentials; it
is not implemented yet. Until then, keep the Mac App on the trusted LAN path.

## Cloudflare resources

- DNS: proxied CNAME `termrelay.wqyhomes.com` to the `jetson-invest` Tunnel.
- Access application: self-hosted application named `termrelay`.
- Authentication: email one-time PIN with a single-email allow policy.
- Session duration: 24 hours.
- Origin authorization: Cloudflare Access performs browser authentication at the edge; the Server trusts requests that Access forwards through the Tunnel.

Do not add a bypass policy for `/ws/web` or the existing `/ws/client`: the
browser sends its Access cookie on the `/ws/web` upgrade, while `/ws/client`
remains LAN-only. The future public Mac route will use the separate
`/ws/client-public` endpoint and server-issued device credentials.

## Validation

Unauthenticated requests must return an Access redirect rather than the
TermRelay page. After authenticating, verify:

1. `https://termrelay.wqyhomes.com/` loads the console.
2. The connection indicator changes to `实时连接正常`.
3. Browser developer tools show an open
   `wss://termrelay.wqyhomes.com/ws/web` connection.
4. Selecting a live LAN-connected Mac session loads output and accepts input.

The Server sends WebSocket ping frames every 25 seconds by default. Override
this with `WEB_SOCKET_PING_INTERVAL_MS` if Cloudflare idle behavior changes.

## Rollback

Disable or remove the `termrelay` Access application, remove the
`termrelay.wqyhomes.com` DNS record, and remove only the matching TermRelay
ingress rule from `jetson-invest`. Preserve the existing `invest.wqyhomes.com`
ingress and final `http_status:404` rule.
