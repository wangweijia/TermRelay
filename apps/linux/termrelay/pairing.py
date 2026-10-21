import json
from urllib.parse import urlunsplit
from urllib.request import Request, urlopen

from .protocol import server_url


def request(url, path, body):
    parsed = server_url(url)
    if parsed.scheme != "wss" or parsed.path != "/ws/client-public":
        raise ValueError("配对只用于 wss://主机/ws/client-public")
    endpoint = urlunsplit(("https", parsed.netloc, path, "", ""))
    data = json.dumps(body).encode("utf-8")
    req = Request(endpoint, data=data, headers={
        "Content-Type": "application/json", "Cache-Control": "no-store",
    })
    with urlopen(req, timeout=15) as response:
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("配对响应过大")
        result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("无效的配对响应")
    return result


def create(url, device_id, name):
    result = request(url, "/api/client-pairings", {
        "deviceId": device_id, "deviceName": name, "appVersion": "0.1.0",
    })
    if (any(not isinstance(result.get(k), str) or not result[k]
            for k in ("pairingId", "deviceCode", "userCode", "verificationURL"))
            or type(result.get("expiresIn")) is not int or not 1 <= result["expiresIn"] <= 3600
            or type(result.get("pollInterval")) is not int or not 1 <= result["pollInterval"] <= 60):
        raise ValueError("无效的配对响应")
    return result


def exchange(url, pairing):
    result = request(url, "/api/client-pairings/token", {
        "pairingId": pairing["pairingId"], "deviceCode": pairing["deviceCode"],
    })
    status = result.get("status")
    if status == "issued":
        if not isinstance(result.get("credential"), str) or not result["credential"]:
            raise ValueError("配对响应缺少凭据")
    elif status not in ("authorization_pending", "access_denied", "expired_token"):
        raise ValueError("未知的配对响应")
    return result
