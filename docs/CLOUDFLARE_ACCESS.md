# Cloudflare Access deployment

TermRelay Web is published at your own domain, for example
`https://termrelay.example.com`, through an existing Cloudflare Tunnel.
Replace `termrelay.example.com` and the Tunnel name below with the values you
actually configure for your deployment.

## Traffic paths

- Browsers use Cloudflare Access and Tunnel to reach `http://localhost:3006`
  on the Jetson.
- The Mac App continues to connect directly to the Jetson LAN address at
  `ws://JETSON_LAN_IP:3006/ws/client` and does not traverse Cloudflare.
- The browser derives `wss://termrelay.example.com/ws/web` from the page URL.

Mac App public-domain pairing over an authenticated `/ws/client-public`
connection is implemented and documented in
[Mac Client 公网配对与认证方案](CLOUDFLARE_MAC_CLIENT_AUTH.md). The design uses
path-specific Access Bypass rules (turn off "Protect with Access" only for the
pairing and `/ws/client-public` routes) plus TermRelay-issued device
credentials. It is optional: if the Mac App always stays on the trusted LAN,
none of this is required.

## Cloudflare resources

- DNS: proxied CNAME `termrelay.example.com` to your Cloudflare Tunnel.
- Access application: self-hosted application named `termrelay`.
- Authentication: email one-time PIN with a single-email allow policy.
- Session duration: 24 hours.
- Origin authorization: Cloudflare Access performs browser authentication at the edge; the Server trusts requests that Access forwards through the Tunnel.

Do not add a bypass policy for `/ws/web` or the existing `/ws/client`: the
browser sends its Access cookie on the `/ws/web` upgrade, while `/ws/client`
remains LAN-only. The public Mac route uses the separate `/ws/client-public`
endpoint and server-issued device credentials; see
[Mac Client 公网配对与认证方案](CLOUDFLARE_MAC_CLIENT_AUTH.md).

## Validation

Unauthenticated requests must return an Access redirect rather than the
TermRelay page. After authenticating, verify:

1. `https://termrelay.example.com/` loads the console.
2. The connection indicator changes to `实时连接正常`.
3. Browser developer tools show an open
   `wss://termrelay.example.com/ws/web` connection.
4. Selecting a live LAN-connected Mac session loads output and accepts input.

The Server sends WebSocket ping frames every 25 seconds by default. Override
this with `WEB_SOCKET_PING_INTERVAL_MS` if Cloudflare idle behavior changes.

## Rollback

Disable or remove the `termrelay` Access application, remove the
`termrelay.example.com` DNS record, and remove only the matching TermRelay
ingress rule from your Tunnel. Preserve any other existing ingress rules and
the final `http_status:404` rule.
