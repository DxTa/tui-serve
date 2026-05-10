# API reference

All REST endpoints require:

```http
Authorization: Bearer <token>
```

`GET /api/health` does not require auth.

## REST endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Server health |
| `GET` | `/api/sessions` | List sessions |
| `GET` | `/api/sessions/:sessionId` | Get session details |
| `POST` | `/api/sessions` | Create session |
| `PATCH` | `/api/sessions/:sessionId` | Update session metadata |
| `POST` | `/api/sessions/:sessionId/kill` | Kill session; requires `{ "confirm": true }` |
| `POST` | `/api/sessions/:sessionId/restart` | Restart stopped or crashed session |
| `POST` | `/api/sessions/:sessionId/resume` | Resume using agent-native resume support |
| `DELETE` | `/api/sessions/:sessionId` | Delete session record |
| `GET` | `/api/hosts` | List configured hosts |
| `GET` | `/api/commands` | List command IDs available to clients |

## Create session

```http
POST /api/sessions
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "commandId": "pi",
  "cwd": "/home/pi/project",
  "title": "Pi session",
  "id": "optional-stable-id"
}
```

## WebSocket

Connect to:

```text
/ws
```

Protocol:

- `0x00` prefix: terminal binary I/O
- `0x01` prefix: control JSON
- when `AUTH_TOKEN` is configured, first control message must be `{ "type": "auth", "token": "<token>", "clientId": "..." }`

URL query tokens are not supported. Browser UI uses REST endpoints for kill/restart. WebSocket `kill` and `restart` remain capability-gated protocol actions and require explicit controller capabilities; missing capabilities return `CAPABILITY_REQUIRED`.

The browser attaches to a tmux-backed session. Detaching the WebSocket does not stop the underlying agent process.
