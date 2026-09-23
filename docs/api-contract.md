# Contrato de API — IdemEngine

Contrato HTTP del microservicio IdemEngine (Core Fintech) pensado para que un
frontend (o cualquier cliente HTTP) lo consuma. Documenta cada endpoint: método,
ruta, headers, body, query, códigos de respuesta y forma de los payloads.

- **Base URL:** `http://<host>:<port>` (puerto por defecto: `3000`, `process.env.PORT`).
- **Formato:** todas las requests y responses usan `application/json`.
- **Idempotency-Key:** toda mutación exterior (`POST`) **debe** enviar la cabecera
  `Idempotency-Key` (ver [Idempotencia](#idempotencia)).
- **Errores:** todos los errores se devuelven con el cuerpo normalizado
  `{ error, message, details? }` (ver [Formato de error](#formato-de-error)).

---

## Contenido

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Bienvenida del servicio |
| GET | `/health` | Salud de infraestructura (DB + Redis) |
| POST | `/subscriptions` | Crear suscripción |
| GET | `/subscriptions/:id` | Detalle de suscripción + historial |
| POST | `/subscriptions/:id/pause` | Pausar suscripción |
| POST | `/subscriptions/:id/resume` | Reanudar suscripción |
| POST | `/subscriptions/:id/cancel` | Cancelar suscripción |
| POST | `/charges` | Cobro único (crear una Billing Intent) |
| POST | `/subscriptions/:id/billing-cycles/:cycle/charge` | Cobrar ciclo de una suscripción |
| POST | `/subscriptions/:id/billing-cycles/:cycle/reprocess` | Reprocesar una Billing Intent |
| GET | `/notifications/events` | Consultar eventos de la outbox (CancellationEvent) |

---

## Idempotencia

Todas las mutaciones (`POST`) están protegidas por un **Guard de idempotencia**
(`IdempotencyGuard`) más un interceptor de asentamiento. El frontend **debe**:

1. Generar una `Idempotency-Key` por cada operación lógica (un UUID de cliente sirve).
2. Reutilizar **la misma key y el mismo payload** si reintenta la misma operación:
   el servidor devolverá la respuesta original asentada (sin efecto duplicado).
3. No reutilizar la key con un payload distinto (se rechaza con `409`).

Cabecera:

| Header | Regla |
|--------|-------|
| `Idempotency-Key` | Obligatoria. `1..255` caracteres. Vacía o ausente → `400`. |

Estados de la operación dentro de la ventana (24 h):

| Estado de la key | Respuesta |
|------------------|-----------|
| `NEW` (primera vez) | Ejecuta la mutación y asienta (`201`/`200`). |
| `SETTLED` + mismo payload | Replay: misma respuesta, sin efectos. |
| `SETTLED` + payload distinto | `409 IDEMPOTENCY_PAYLOAD_MISMATCH`. |
| `PROCESSING` (en vuelo) | `423 IDEMPOTENCY_LOCKED` con `Retry-After`. |

Concurrencia: ante N requests con la misma key y payload, el sistema produce una
única operación lógica y cero cobros duplicados; el resto recibe `423` o el replay.

---

## Formato de error

Todos los errores usan `NormalizedErrorFilter`:

```json
{
  "error": "ERROR_CODE",
  "message": "Human readable message",
  "details": [
    { "path": "amount", "code": "invalid_type", "message": "..." }
  ]
}
```

`details` solo aparece en errores de validación (Zod). Códigos posibles:

| `error` | HTTP | Significado |
|---------|------|-------------|
| `VALIDATION_ERROR` | 400 | Payload/params/query no válidos (Zod). |
| `BAD_REQUEST` | 400 | Request mal formada. |
| `NOT_FOUND` | 404 | Recurso inexistente. |
| `CONFLICT` | 409 | Conflicto de estado o de idempotencia. |
| `LOCKED` | 423 | Operación en vuelo. |
| `INTERNAL_ERROR` | 500 | Error no controlado. |
| `SERVICE_UNAVAILABLE` | 503 | Dependencia caída (Health). |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta `Idempotency-Key`. |
| `IDEMPOTENCY_KEY_TOO_LONG` | 400 | Key > 255 caracteres. |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | 409 | Key reutilizada con otro payload. |
| `IDEMPOTENCY_LOCKED` | 423 | Key en vuelo (con `Retry-After`). |
| `REPROCESS_NOT_ELIGIBLE` | 409 | Intent no reprocesable (con `reason`). |
| `INVALID_TRANSITION` | 409 | Transición de estado ilegal. |

Los parámetros `:id` y `aggregateId` son UUID v4/v1 canónicos; `:cycle` y las
fechas son `YYYY-MM-DD` válidas.

---

## GET /

Bienvenida del servicio.

**Respuesta** `200 OK`

```text
text/plain
Hello World!
```

---

## GET /health

Chequea conectividad con PostgreSQL (`SELECT 1`) y Redis (`PING`).

**Respuesta** `200 OK` (si todo está arriba):

```json
{
  "status": "ok",
  "details": {
    "database": "up",
    "redis": "up"
  }
}
```

**Respuesta** `503 Service Unavailable` (si algún componente cae; el cuerpo es el
mismo con `status: "error"` y la dependencia en `"down"`):

```json
{
  "status": "error",
  "details": {
    "database": "up",
    "redis": "down"
  }
}
```

---

## POST /subscriptions

Crea una suscripción recurrente. Mutación idempotente.

**Headers**

| Header | Valor |
|--------|-------|
| `Idempotency-Key` | Obligatoria. |
| `Content-Type` | `application/json`. |

**Body**

```json
{
  "amount": 1500,
  "currency": "USD",
  "frequency": "monthly",
  "startDate": "2026-10-01",
  "timezone": "America/Argentina/Buenos_Aires"
}
```

| Campo | Tipo | Reglas |
|-------|------|--------|
| `amount` | number | Entero positivo (int). |
| `currency` | string | Código ISO 4217 (3 letras mayúsculas). |
| `frequency` | string enum | `daily` \| `weekly` \| `monthly` \| `annual`. |
| `startDate` | string | Fecha `YYYY-MM-DD` válida. No puede estar en el pasado. |
| `timezone` | string | Zona IANA válida (ej. `America/Argentina/Buenos_Aires`, `UTC`). |

**Respuesta** `201 Created`

```json
{
  "id": "a1b2c3d4-...",
  "amount": 1500,
  "currency": "USD",
  "frequency": "monthly",
  "startDate": "2026-10-01",
  "timezone": "America/Argentina/Buenos_Aires",
  "status": "ACTIVE",
  "createdAt": "2026-09-22T14:30:00.000Z"
}
```

`status` inicial: `ACTIVE`.

**Replay idempotente:** la misma key + mismo body devuelve `201` con el body
idéntico del asentamiento original (misma suscripción, sin duplicado).

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta la key. |
| `VALIDATION_ERROR` | 400 | `details` indica el campo inválido (`amount`, `currency`, `frequency`, `startDate`, `timezone`). |

---

## GET /subscriptions/:id

Detalle de una suscripción con su historial completo de Billing Intents y
Payment Attempts. **No es idempotente** (lectura).

**Path params**

| Param | Tipo | Regla |
|-------|------|-------|
| `id` | string | UUID válido. |

**Respuesta** `200 OK`

```json
{
  "id": "a1b2c3d4-...",
  "amount": 1500,
  "currency": "USD",
  "frequency": "monthly",
  "startDate": "2026-10-01",
  "timezone": "America/Argentina/Buenos_Aires",
  "status": "ACTIVE",
  "nextBillingDate": "2026-11-01",
  "createdAt": "2026-09-22T14:30:00.000Z",
  "cancelledAt": null,
  "billingIntents": [
    {
      "id": "b1c2d3e4-...",
      "billingCycle": "2026-10-01",
      "scheduleDate": "2026-10-01",
      "amount": 1500,
      "currency": "USD",
      "status": "SUCCEEDED",
      "settledAt": "2026-10-01T12:00:00.000Z",
      "createdAt": "2026-09-25T00:00:00.000Z",
      "omittedReason": null,
      "needsManualReview": false,
      "attempts": [
        {
          "id": "c1d2e3f4-...",
          "attemptNo": 1,
          "providerOperationId": "b1c2d3e4-...:1",
          "status": "SUCCEEDED",
          "errorType": null,
          "startedAt": "2026-10-01T12:00:00.000Z",
          "finishedAt": "2026-10-01T12:00:01.000Z",
          "trigger": "AUTO"
        }
      ]
    }
  ]
}
```

| Campo | Tipo | Notas |
|-------|------|-------|
| `status` | string enum | `ACTIVE` \| `PAUSED` \| `CANCELLED`. |
| `nextBillingDate` | string or null | Solo si `ACTIVE`. Fecha del siguiente ciclo desde el ancla. |
| `cancelledAt` | string or null | Timestamp si fue cancelada. |
| `billingIntents[].status` | string enum | `SCHEDULED` \| `IN_FLIGHT` \| `RETRY_PENDING` \| `SUCCEEDED` \| `FAILED_FINAL` \| `UNKNOWN` \| `OMITTED`. |
| `billingIntents[].omittedReason` | string or null | `ENGINE_DOWN` \| `SUBSCRIPTION_PAUSED` \| `SUBSCRIPTION_CANCELLED` \| `OVERLAP`. |
| `billingIntents[].needsManualReview` | boolean | `true` cuando una intent `UNKNOWN` supera 24 h o 10 verificaciones. |
| `attempts[].status` | string enum | `IN_FLIGHT` \| `SUCCEEDED` \| `FAILED` \| `UNKNOWN`. |
| `attempts[].attemptNo` | number or null | Secuencia automática; `null` para attempts `MANUAL`. |
| `attempts[].errorType` | string or null | `PROVIDER_ERROR` \| `TEMPORARY_UNAVAILABLE` \| `TIMEOUT` \| `AMBIGUOUS` \| `DECLINED` \| etc. |
| `attempts[].trigger` | string enum | `AUTO` \| `MANUAL`. |

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `VALIDATION_ERROR` | 400 | `id` no es UUID. |
| `NOT_FOUND` | 404 | Suscripción inexistente. |

---

## POST /subscriptions/:id/pause

Pausa una suscripción. Mutación idempotente. Una suscripción `PAUSED` no genera
nuevas Billing Intents ni inicia retries pendientes; un Payment Attempt ya
`IN_FLIGHT` puede terminar.

**Headers**

| Header | Valor |
|--------|-------|
| `Idempotency-Key` | Obligatoria. |

**Path params**

| Param | Tipo | Regla |
|-------|------|-------|
| `id` | string | UUID válido. |

**Body:** vacío (`{}`).

**Respuesta** `200 OK` — Detalle de la suscripción pausada (mismo shape que
`GET /subscriptions/:id`), con `status: "PAUSED"` y las intents programadas ya
omitidas.

```json
{
  "id": "a1b2c3d4-...",
  "status": "PAUSED",
  ...
}
```

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `VALIDATION_ERROR` | 400 | `id` no es UUID. |
| `NOT_FOUND` | 404 | Suscripción inexistente. |
| `INVALID_TRANSITION` | 409 | Transición no permitida (ej. pausar una suscripción cancelada). |

---

## POST /subscriptions/:id/resume

Reanuda una suscripción (solo `PAUSED → ACTIVE`). Mutación idempotente. No hace
catch-up: el siguiente cobro es el próximo ciclo de calendario posterior a la
reanudación.

**Headers**

| Header | Valor |
|--------|-------|
| `Idempotency-Key` | Obligatoria. |

**Path params**

| Param | Tipo | Regla |
|-------|------|-------|
| `id` | string | UUID válido. |

**Body:** vacío (`{}`).

**Respuesta** `200 OK` — Detalle de la suscripción con `status: "ACTIVE"`.

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `VALIDATION_ERROR` | 400 | `id` no es UUID. |
| `NOT_FOUND` | 404 | Suscripción inexistente. |
| `INVALID_TRANSITION` | 409 | Reanudar una suscripción no pausada o cancelada. |

---

## POST /subscriptions/:id/cancel

Cancela una suscripción. Mutación idempotente. Una suscripción `CANCELLED` no
genera nuevos cobros; un attempt `IN_FLIGHT` puede terminar y su resultado se
conserva. Persiste un `CancellationEvent` mediante outbox en la misma transacción.

**Headers**

| Header | Valor |
|--------|-------|
| `Idempotency-Key` | Obligatoria. |

**Path params**

| Param | Tipo | Regla |
|-------|------|-------|
| `id` | string | UUID válido. |

**Body:** vacío (`{}`).

**Respuesta** `200 OK` — Detalle de la suscripción con `status: "CANCELLED"` y
`cancelledAt` poblado.

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `VALIDATION_ERROR` | 400 | `id` no es UUID. |
| `NOT_FOUND` | 404 | Suscripción inexistente. |
| `INVALID_TRANSITION` | 409 | Cancelar una suscripción ya cancelada. |

---

## POST /charges

Cobro único. Crea una Billing Intent de prueba (operación usada en escenarios de
concurrencia/validación). Mutación idempotente.

**Headers**

| Header | Valor |
|--------|-------|
| `Idempotency-Key` | Obligatoria. |
| `Content-Type` | `application/json`. |

**Body**

```json
{
  "amount": 100,
  "currency": "USD"
}
```

| Campo | Tipo | Reglas |
|-------|------|--------|
| `amount` | number | Positivo. |
| `currency` | string | Exactamente 3 caracteres. |

**Respuesta** `201 Created`

```json
{
  "id": "b1c2d3e4-...",
  "status": "CREATED",
  "amount": 100,
  "currency": "USD"
}
```

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Falta la key. |
| `VALIDATION_ERROR` | 400 | `amount` o `currency` inválidos. |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | 409 | Key reutilizada con payload distinto. |
| `IDEMPOTENCY_LOCKED` | 423 | Key en vuelo. |

---

## POST /subscriptions/:id/billing-cycles/:cycle/charge

Cobra el ciclo de una suscripción. Get-or-create de la Billing Intent por
`(subscription_id, billing_cycle)` y solicita su ejecución; si ya existe,
devuelve su estado actual. Mutación idempotente (ejercita la dedupe por ciclo).

**Headers**

| Header | Valor |
|--------|-------|
| `Idempotency-Key` | Obligatoria. |

**Path params**

| Param | Tipo | Regla |
|-------|------|-------|
| `id` | string | UUID válido de la suscripción. |
| `cycle` | string | Fecha `YYYY-MM-DD` válida del ciclo a cobrar. |

**Body:** vacío (`{}`).

**Respuesta** `200 OK`

```json
{
  "id": "b1c2d3e4-...",
  "subscriptionId": "a1b2c3d4-...",
  "billingCycle": "2026-10-01",
  "scheduleDate": "2026-10-01",
  "amount": 1500,
  "currency": "USD",
  "status": "SUCCEEDED",
  "omittedReason": null,
  "settledAt": "2026-10-01T12:00:00.000Z",
  "created": false
}
```

| Campo | Tipo | Notas |
|-------|------|-------|
| `status` | string enum | Estado actual de la intent. |
| `omittedReason` | string or null | Motivo si `OMITTED`. |
| `settledAt` | string or null | Timestamp de asentamiento. |
| `created` | boolean | `true` si la intent se creó en esta request, `false` si ya existía. |

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `VALIDATION_ERROR` | 400 | `id` no es UUID o `cycle` no es `YYYY-MM-DD`. |
| `CONFLICT` | 409 | Suscripción no activa. |
| `NOT_FOUND` | 404 | Suscripción inexistente. |

---

## POST /subscriptions/:id/billing-cycles/:cycle/reprocess

Reprocesa una Billing Intent `UNKNOWN` o `FAILED_FINAL`. Crea un Payment Attempt
`MANUAL` (`trigger=MANUAL`, `auto_seq` nulo, sin retries automáticos) sobre la
misma intent. No reactiva una suscripción `CANCELLED`. Mutación idempotente.

**Headers**

| Header | Valor |
|--------|-------|
| `Idempotency-Key` | Obligatoria. |

**Path params**

| Param | Tipo | Regla |
|-------|------|-------|
| `id` | string | UUID válido de la suscripción. |
| `cycle` | string | Fecha `YYYY-MM-DD` válida del ciclo a reprocesar. |

**Body:** vacío (`{}`).

**Respuesta** `200 OK`

```json
{
  "id": "b1c2d3e4-...",
  "subscriptionId": "a1b2c3d4-...",
  "billingCycle": "2026-10-01",
  "scheduleDate": "2026-10-01",
  "amount": 1500,
  "currency": "USD",
  "status": "SUCCEEDED",
  "omittedReason": null,
  "settledAt": "2026-10-01T12:30:00.000Z"
}
```

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `VALIDATION_ERROR` | 400 | Params inválidos. |
| `NOT_FOUND` | 404 | Suscripción o intent inexistente para el ciclo. |
| `REPROCESS_NOT_ELIGIBLE` | 409 | Intent no reprocesable. El cuerpo incluye `reason`. |
| `CONFLICT` | 409 | Otra transición ilegal (ej. intent ya `IN_FLIGHT`). |

`REPROCESS_NOT_ELIGIBLE` con sus motivos:

```json
{
  "error": "REPROCESS_NOT_ELIGIBLE",
  "message": "Billing intent is not eligible for reprocess",
  "reason": "ALREADY_SUCCEEDED"
}
```

| `reason` | Significado |
|----------|-------------|
| `ALREADY_SUCCEEDED` | Intent ya cobrada. |
| `UNKNOWN_UNVERIFIABLE` | Intent `UNKNOWN` sin `providerOperationId` o cuya verificación sigue `UNKNOWN`. |
| `NOT_ELIGIBLE_STATUS` | Cualquier otro estado no reprocesable. |

---

## GET /notifications/events

Consulta los eventos de la outbox (dominio persistido). Actualmente solo se
emiten `CancellationEvent`. La outbox se persiste en la misma transacción que el
hecho de dominio. Lectura (no idempotente).

**Query params** (ambos opcionales)

| Param | Tipo | Regla |
|-------|------|-------|
| `type` | string enum | `CancellationEvent`. |
| `aggregateId` | string | UUID válido (id de la suscripción). |

**Respuesta** `200 OK`

```json
{
  "events": [
    {
      "id": "e1f2a3b4-...",
      "type": "CancellationEvent",
      "aggregateId": "a1b2c3d4-...",
      "payload": {},
      "status": "PENDING",
      "createdAt": "2026-10-01T12:00:00.000Z"
    }
  ]
}
```

| Campo | Tipo | Notas |
|-------|------|-------|
| `type` | string enum | Solo `CancellationEvent` en esta versión. |
| `payload` | object | Carga del evento (motivo de cancelación, etc.). |
| `status` | string | Siempre `PENDING` (transporte externo fuera de alcance). |

**Errores**

| Código | HTTP | Detalle |
|--------|------|---------|
| `VALIDATION_ERROR` | 400 | `type` inválido o `aggregateId` no es UUID. |

---

## Notas generales para el frontend

- **Todas las fechas** de respuesta son timestamps ISO 8601 (UTC); las fechas de
  calendario (`startDate`, `billingCycle`, `scheduleDate`, `nextBillingDate`)
  son `YYYY-MM-DD` sin zona horaria (pertenecen a la `timezone` de la suscripción).
- **Los montos** se expresan en la unidad menor de la moneda (entero). Para USD
  son centavos.
- **Retry del cliente:** ante `423 IDEMPOTENCY_LOCKED` se puede reintentar con la
  misma key y payload respetando `Retry-After` (segundos). Ante `5xx` también se
  puede reintentar con la misma key: el servidor deduplicará.
- **Cancelación/agotamiento:** al agotar 5 attempts automáticos o recibir un error
  no reintentable, la suscripción pasa a `CANCELLED` automáticamente y se emite un
  `CancellationEvent` (consultable en `/notifications/events`). El detalle de la
  suscripción refleja el estado.
- **Monitoreo:** `GET /health` es la señal de liveness para load balancers;
  estado `503` indica degradación.
```