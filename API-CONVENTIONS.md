# Zenceglow Ops — API Conventions

Based on [Senapixel Server API Conventions](https://github.com/). Routing and method rules follow Senapixel; response envelope aligns with zenceglow-server.

---

## 1. URL Naming

### Nouns are singular, never plural

```text
✅ /api/ops/service          ❌ /api/ops/services
✅ /api/ops/log              ❌ /api/ops/logs
```

### List endpoints use a `/list` suffix

```text
✅ GET /api/ops/service/list
```

Bounded collections may use a descriptive name without `/list`:

```text
✅ GET /api/ops/system/overview
```

### Single-resource detail uses query params, not path segments

```text
✅ DELETE /api/ops/service?id=
✅ GET    /api/ops/service/log?id=&tail=
❌ DELETE /api/ops/service/{id}
```

### Action verbs are appended as path segments

```text
✅ POST /api/ops/auth/login
✅ POST /api/ops/setup/complete
✅ POST /api/ops/service/start
✅ POST /api/ops/gateway/reload
```

---

## 2. HTTP Method Semantics

| Method   | Used for                         | Params location   |
|----------|----------------------------------|-------------------|
| `GET`    | Read (list, detail, status)      | Query string only |
| `POST`   | Create, submit, custom actions   | JSON body         |
| `PUT`    | Update                           | JSON body         |
| `DELETE` | Delete                           | Query string only |

**Critical:** `GET` and `DELETE` parameters MUST be in the query string. Only `POST` and `PUT` may read from the request body.

---

## 3. Request / Response Types

Every public endpoint defines dedicated request and response structs. Do not leak sensitive DB fields (e.g. `password_hash`).

### Unified envelope (zenceglow-server compatible)

```json
{
  "success": true,
  "code": 200,
  "message": "Successfully",
  "data": {}
}
```

| Constant | Value | Use |
|----------|-------|-----|
| `CODE_OK` | 200 | Success |
| `CODE_FAIL` | 0 | Generic failure |
| `CODE_BAD_REQUEST` | 400 | Bad request |
| `CODE_UNAUTHORIZED` | 401 | Auth |
| `CODE_FORBIDDEN` | 403 | Forbidden |
| `CODE_NOT_FOUND` | 404 | Not found |
| `CODE_SERVER_ERROR` | 500 | Internal |
| `CODE_BIZ_ERROR` | 1000 | Business error |

---

## 4. Canonical Ops Routes

### Public

```text
POST   /api/ops/auth/login
GET    /api/ops/setup/status
POST   /api/ops/setup/complete
```

### Protected (Bearer)

```text
POST   /api/ops/auth/login
GET    /api/ops/auth/me                JWT; returns { id, username, role, permissions }

GET    /api/ops/permission/list        catalog of permission ids

GET    /api/ops/member/list            requires ops.member.manage
GET    /api/ops/member?id=
POST   /api/ops/member/create          body: { username, password, permissions[] }
PUT    /api/ops/member                 body: { id, password?, permissions? }
DELETE /api/ops/member?id=

GET    /api/ops/system/overview        requires ops.system.read
# … service / gateway / log / ssh gated by ops.* permissions
```

---

## 5. Checklist

- [ ] Singular noun, no plurals
- [ ] Paginated / collection list → `/list`
- [ ] Single item → query param `?id=`
- [ ] GET / DELETE → query string only
- [ ] POST / PUT → JSON body
- [ ] Dedicated request/response structs
- [ ] Response wrapped in `ApiResponse`
