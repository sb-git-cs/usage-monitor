# Phone link protocol (v1)

How the Android app reads plan meters from Usage Monitor on a computer. The computer side is `src/phone.js`; the phone side is `android/app/src/main/java/io/github/sbgitcs/usagemonitor/pairing/`. Both are tested against the same vectors in `test/fixtures/phone-vectors.json`.

## Turning it on

Settings → Phone → **Share plan meters with my phone over this network**. Off by default. When on, the app listens on TCP port 47329 (changeable) on every IPv4 interface. Nothing is served without a valid signature.

## Pairing

**Pair a phone…** creates a 20-character code from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (about 98 bits), shown as `XXXXX-XXXXX-XXXXX-XXXXX` and in a QR code:

```
usagemonitor://pair?h=192.168.1.20,100.101.102.103&p=47329&c=ABCDE-FGHJK-MNPQR-STVWX&n=Studio+PC
```

`h` lists the computer's IPv4 addresses, LAN first (a Tailscale or other VPN address is included, so the phone can reach the computer away from home). `n` is the computer's name. The code is valid for 10 minutes and pairs one phone. It never crosses the network: both sides derive everything from it.

- normalized code: upper case, only letters and digits (`ABCDEFGHJKMNPQRSTVWX`)
- device id: first 16 hex digits of `SHA-256("um-id:" + normalized code)`
- master key: `HKDF-SHA256(ikm = normalized code, salt = "usage-monitor", info = "um-key-v1", 32 bytes)`
- MAC key: `HKDF-SHA256(ikm = master key, salt = empty, info = "um-mac-v1", 32 bytes)`
- encryption key: `HKDF-SHA256(ikm = master key, salt = empty, info = "um-enc-v1", 32 bytes)`

The first correctly signed request with the pending code's device id completes the pairing; the computer then stores the id, the master key and the phone's name (`X-UM-Name`, URL-encoded). **Remove** in Settings revokes a phone.

## Requests

```
GET /v1/ping        confirms a pairing; answers { ok: true, name }
GET /v1/snapshot    plan meters and live readings
X-UM-Id:   device id
X-UM-Time: milliseconds since 1970, within 5 minutes of the computer's clock
X-UM-Sig:  base64url(HMAC-SHA256(MAC key, "GET\n" + path + "\n" + time))
X-UM-Name: phone name (optional, used when pairing)
```

Wrong or missing signatures get `401`; more than 20 failures a minute from one address get `429`.

## Responses

```json
{ "v": 1, "iv": "<12 bytes, base64url>", "data": "<ciphertext + 16-byte tag, base64url>" }
```

AES-256-GCM with the encryption key, and the request's `X-UM-Time` (as a decimal string) as additional authenticated data, so an answer recorded earlier fails to decrypt for a new request.

`/v1/snapshot` plaintext:

```json
{
  "v": 1,
  "app_version": "1.3.0",
  "name": "Studio PC",
  "generated_at": "2026-09-29T10:00:00.000Z",
  "alert_threshold": 80,
  "providers": [
    {
      "id": "claude", "display_name": "Claude Code", "plan": "Max 20x",
      "status": { "state": "ok", "hint": null },
      "fetched_at": "2026-09-29T09:59:58.000Z",
      "windows": [
        { "kind": "five_hour", "label": "5h", "used_pct": 62, "resets_at": "2026-09-29T12:10:00.000Z",
          "forecast_at": "2026-09-29T11:20:00.000Z", "burn_per_hour": 28.5 }
      ]
    }
  ],
  "system": { "cpu": 12.5, "mem": 48.1, "gpu": 3, "disk": 8, "disk_rate": null, "space": 71.2 },
  "network": { "state": "running", "rx_rate": 125000, "tx_rate": 8000, "hour": { "rx": 1.2e9, "tx": 9e7 }, "top": [] }
}
```

`forecast_at` is present only when the window is on course to reach 100% before `resets_at`. Unknown fields are ignored by the phone; new fields may be added without changing `v`.
