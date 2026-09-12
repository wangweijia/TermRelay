# Cloudflare Access deployment

TermRelay Web is published at `https://termrelay.wqyhomes.com` through the
existing remotely managed `jetson-invest` Cloudflare Tunnel.

## Traffic paths

- Browsers use Cloudflare Access and Tunnel to reach `http://localhost:3006`
  on the Jetson.
- The Mac App continues to connect directly to the Jetson LAN address at
  `ws://JETSON_LAN_IP:3006/ws/client` and does not traverse Cloudflare.
- The browser derives `wss://termrelay.wqyhomes.com/ws/web` from the page URL.

## Cloudflare resources

- DNS: proxied CNAME `termrelay.wqyhomes.com` to the `jetson-invest` Tunnel.
- Access application: self-hosted application named `termrelay`.
- Authentication: email one-time PIN with a single-email allow policy.
- Session duration: 24 hours.
- Tunnel origin validation: Access JWT validation is required for this ingress.

Do not add a bypass policy for `/ws/web`: the browser sends its Access cookie
on the WebSocket upgrade request. The `/ws/client` endpoint is not used through
the public hostname.

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
