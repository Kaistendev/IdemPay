# Guía del Motor — Cómo funciona IdemEngine

Documentación conceptual (en español) para entender el funcionamiento interno del motor de cobranza recurrente. El **código** mantiene sus identificadores en inglés; aquí se describen los conceptos y flujos.

---

## 1. Qué es IdemEngine

**IdemEngine** es un microservicio de cobranza recurrente **idempotente y tolerante a fallos**. Su objetivo: cobrar a un suscriptor el mismo monto en cada ciclo (día, semana, mes o año) sin cobrar **nunca dos veces** por el mismo evento, incluso cuando hay reintentos, caídas del proveedor de pagos o alta concurrencia.

Tres ideales de diseño (ver `docs/constitution.md`):

1. **Idempotencia es ley** — toda mutación requiere una `Idempotency-Key`; el sistema nunca duplica efectos.
2. **No se cobra sin registro previo** — cada cobro se escribe a PostgreSQL (write-ahead) **antes** de llamar al proveedor.
3. **Lo ambiguo no se cobra a ciegas** — un resultado incierto del proveedor pasa a estado `UNKNOWN` y se verifica con el proveedor antes de decidir.

Stack: **NestJS + TypeScript**, **PostgreSQL** (fuente de verdad), **Redis + BullMQ** (cola y cerrojos de idempotencia).

---

## 2. Arquitectura y módulos

```
app.module
├── common          → time, validación Zod, errores, idempotency helpers
├── health          → GET /health y pool de PostgreSQL
├── database        → migraciones y runner
├── idempotency     → guard + registro/settle en PostgreSQL
├── calendar        → días hábiles, festivos y fechas de ciclo
├── subscriptions   → alta, consultas y ciclo de vida (pause/resume/cancel)
├── charges         → cargo manual simple (POST /charges)
├── billing-cycles  → cargo manual de un ciclo (POST /charges/cycle)
├── scheduler       → sweep de programación de billing intents
├── dispatcher      → cola BullMQ: encola intents vencidos
├── charge-executor → ejecución con write-ahead, verificación y recuperación
├── gateway         → adaptador de pasarela (IPaymentGateway + Mock)
├── retry           → política de reintentos y backoff exponencial
├── transitions     → máquina de estados (assertTransition)
├── notifications   → outbox de eventos (append-only)
└── reprocess       → reproceso manual de intents fallidos
```

---

## 3. Conceptos clave

| Concepto            | Definición                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subscription**    | El contrato de cobro recurrente: `amount`, `currency`, `frequency`, `startDate`, `timezone`, `status`.                                                                                 |
| **Billing Intent**  | La intención de cobrar **un ciclo específico** (una fecha). Tiene su propio estado y monto. Una suscripción nunca tiene más de una intent _viva_ por ciclo.                            |
| **Payment Attempt** | Un intento concreto de cobrar una billing intent contra el proveedor. Hasta **5** intentos automáticos (`MAX_ATTEMPTS`) por intent. Cada attempt tiene un `providerOperationId` único. |
| **Billing Cycle**   | La fecha nominal del ciclo (ej. `2026-02-15`) derivada del `startDate` y la `frequency`.                                                                                               |
| **Schedule Date**   | El primer **día hábil** (no fin de semana, no festivo) del ciclo.                                                                                                                      |
| **Idempotency-Key** | Header obligatorio en todas las operaciones mutantes. Deduplica solicitudes repetidas dentro de **24 h**.                                                                              |

---

## 4. Flujo de extremo a extremo

### 4.1 Alta de suscripción (`POST /subscriptions`)

1. El guard de idempotencia valida la `Idempotency-Key` (ver §5).
2. Zod valida el payload (`amount` entero positivo, `currency` ISO 4217, `frequency`, `startDate`, `timezone` IANA).
3. Se inserta la fila en `subscriptions` con `status = 'ACTIVE'` y `anchor_date = startDate`.
4. Se fija la suscripción a `ACTIVE`. El cobro aún **no** ocurre: lo agenda el scheduler.

### 4.2 Programación de ciclos (`scheduler/billing-scheduler.service.ts`)

El `BillingSchedulerService.sweep()` se ejecuta periódicamente (por cron externa). Por cada suscripción `ACTIVE`:

1. Calcula las fechas nominales de ciclo desde el ancla (`calendar.currentCycleDate` / `cycleDateAt`).
2. Para cada ciclo cuyo `scheduleDate` (primer día hábil) ya pasó y **no** tiene billing intent, crea una intent `SCHEDULED`.
3. Si la fecha de cobro se atrasó más de la tolerancia (`ENGINE_DOWN_TOLERANCE_MINUTES`, por defecto **15 min**), la intent se crea como `OMITTED` con razón `ENGINE_DOWN` — el ciclo se considera perdido (el motor estuvo caído) y no se intenta cobrar.
4. Si en un ciclo intermedio ya existe una intent **viva** (`SCHEDULED | IN_FLIGHT | RETRY_PENDING | UNKNOWN`), bloquea la creación de ciclos posteriores y, si están vencidas por tolerancia, las omite con razón `OVERLAP`. Esto garantiza que **nunca coexistan dos cobros vivos para la misma suscripción** (índice único parcial en BD).

### 4.3 Dispatch (cola BullMQ, `dispatcher/`)

Cada segundo (`CHARGE_DISPATCH_INTERVAL_MS`, por defecto **1000 ms**), el `ChargeDispatcherService`:

1. Consulta intents `SCHEDULED | RETRY_PENDING` cuyo `next_attempt_at <= now()` (lote de `DISPATCH_BATCH_SIZE`, por defecto 100) usando `FOR UPDATE SKIP LOCKED` — varios workers no capturan la misma intent.
2. Encola cada intent en la cola `charges.execute` con `jobId = billingIntentId` (deduplicación a nivel de cola).

Un `Worker` de BullMQ (`concurrency: 1`) consume la cola y llama al `ChargeExecutorService.execute(intentId)`.

### 4.4 Ejecución del cobro — write-ahead (`charge-executor/`)

El executor implementa un patrón **write-ahead**: primero se registra el intento, después se cobra.

**`startAttempt(intentId)`** (transacción con `SELECT ... FOR UPDATE`):

1. Bloquea la billing intent; valida que sea `SCHEDULED` o `RETRY_PENDING` (y que el retry esté vencido). Si está `IN_FLIGHT` → `ALREADY_IN_FLIGHT` (ya nadie lo está procesando).
2. Calcula `attemptNo = MAX(auto_seq) + 1`; si `attemptNo > 5` → `ATTEMPTS_EXHAUSTED`.
3. Genera `providerOperationId` determinista (`buildProviderOperationId(intentId, attemptNo)`).
4. Inserta el **payment attempt** con estado `IN_FLIGHT`, trigger `AUTO` y `deadline_at = now() + EXECUTION_TIMEOUT_MS` (**60 s** por defecto).
5. Marca la intent `IN_FLIGHT` y hace COMMIT.

Solo entonces se llama al proveedor:

```
charge = gateway.charge({ providerOperationId, amount, currency })
verify = gateway.verify(providerOperationId)
```

**`settleAttempt(...)`** (segunda transacción):

- `verify == SUCCEEDED` → intent `SUCCEEDED`, attempt `SUCCEEDED`, `settled_at = now()`.
- `verify == FAILED` (con error tipificado):
  - error **retryable** → intent `RETRY_PENDING` + `next_attempt_at` por backoff (ver §6).
  - error **no retryable** o intentos agotados → intent `FAILED_FINAL`, attempt `FAILED`, y **se cancela la suscripción** (motivo `FAILED_FINAL`), omitiendo las intents restantes que estén `SCHEDULED | RETRY_PENDING`.
- `verify == UNKNOWN` → intent y attempt `UNKNOWN` (ver §7).

Gracias a que el attempt `IN_FLIGHT` se escribe antes del cobro, si el proceso muere _durante_ la llamada al proveedor, la recuperación (§7) lo detecta por el `deadline_at` vencido y nunca se pierde el cobro _ni_ se duplica.

### 4.5 Carga de intent original de una suscripción que falla

Cuando una suscripción alcanza `FAILED_FINAL`, el motor **cancela la suscripción** de forma automática (invariante de negocio): al ser un cobro sin éxito (rechazo firme o agotamiento de intentos) no tiene sentido prolongar el mandato. Esta transición se hace dentro de la misma transacción del settle y emite una notificación de tipo `CancellationEvent` en el outbox.

---

## 5. Idempotencia (guard + registro en PostgreSQL)

`src/idempotency/idempotency.guard.ts` intercepta las rutas mutantes. Flujo por petición:

1. **Redis lock** (`SETNX` con TTL de 2 s por clave `idem:lock:<key>`) serializa peticiones concurrentes con la misma key.
2. **`IdempotencyRepository.registerOrGet(key, payloadHash, operationType)`** — transacción con `FOR UPDATE`:
   - Si no existe la key → inserta `.PROCESSING` con `expires_at = now() + 24 h` y lease de **5 min**; retorna `NEW`.
   - Si existe y **expiró** (`expires_at` pasado) → nueva _generación_; retorna `NEW` de esa generación.
   - Si el `payload_hash` **no coincide** → `MISMATCH` → `409 Conflict`.
   - Si está `SETTLED` → `REPLAY`: reenvía la respuesta original guardada (201/409/…).
   - Si está `PROCESSING` con lease vigente → `IN_FLIGHT` → `423 Locked` (con `leaseRemainingSeconds`).
   - Si está `PROCESSING` con lease expirado → `RETAKE`: se renueva el lease y se re-ejecuta (el `FOR UPDATE` de la intención de cobro impide el doble cobro de todos modos).
3. La operación de negocio se ejecuta **en la misma transacción (mismo `PoolClient`)** que el settle del registro (`IdempotencyRepository.settle`) — se guardan `response_status`, `response_body` y el `billing_intent_id` de referencia.

**Resultado:** una petición repetida dentro de 24 h devuelve el mismo resultado, no re-cobra, y su `payload` se compara por hash (un payload distinto con la misma key es un `409`).

---

## 6. Reintentos: exponential backoff + jitter

La clasificación de errores (`gateway/payment-error.ts`):

| Disposición     | Errores                                                                   | Comportamiento                           |
| --------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `RETRYABLE`     | `PROVIDER_ERROR`, `TEMPORARY_UNAVAILABLE`                                 | Reintentar                               |
| `AMBIGUOUS`     | `TIMEOUT`, `AMBIGUOUS`                                                    | Reintentar (vía `UNKNOWN` si no tipable) |
| `NON_RETRYABLE` | `DECLINED`, `INVALID_PAYMENT`, `INVALID_AMOUNT`, `CANCELLED_SUBSCRIPTION` | Fallo final                              |

Política (`retry/retry-policy.ts`): se reintenta hasta **5** intentos (`DEFAULT_MAX_RETRIES`); al superarlos → `FAILED_FINAL`.

Backoff (`retry/backoff.ts`):

```
delay = min(baseDelayMs * factor^retryIndex * (1 - jitterRatio + 2*jitterRatio*rand()), maxDelayMs)
baseDelayMs = 10 s, factor = 2, jitterRatio = 0.2, maxDelayMs = 1 h
```

El `next_attempt_at` se persiste en la intención; el dispatcher lo recoge cuando vence. Como cada reintento usa un **`providerOperationId` nuevo y determinista**, y el Mock de la pasarela memoiza por `providerOperationId`, cada intento es verificable de forma independiente.

---

## 7. Resultados `UNKNOWN` y recuperación

Dos procesos de fondo (`OnApplicationBootstrap` → `setInterval`):

### 7.1 Recovery sweep (`charge-recovery.sweep.service.ts`, cada **30 s**)

Busca payment attempts `IN_FLIGHT` cuyo `deadline_at` venció (proceso murió durante el cobro) y los marca `UNKNOWN` (la intent pasa a `UNKNOWN`). **Nunca cancela ni re-cobra**: deja constancia y delega la resolución a la verificación.

### 7.2 Verification sweep (`charge-verification.sweep.service.ts`, cada **5 s**)

Toma intents `UNKNOWN` y consulta al proveedor con `verify(providerOperationId)`:

- `UNKNOWN` de nuevo → reprograma `next_verify_at` con backoff más agresivo (base **60 s**, factor 2, máx 1 h); tras **10** verificaciones o **24 h** en `UNKNOWN` → `needs_manual_review = true` (revisión manual, no se decide solo).
- `SUCCEEDED` → la intent pasa a `SUCCEEDED` (el cobro sí ocurrió; se regulariza).
- `FAILED`:
  - suscripción `ACTIVE` → intent `RETRY_PENDING` (se reintenta con backoff).
  - suscripción `PAUSED`/`CANCELLED` → intent `OMITTED` (razón `SUBSCRIPTION_PAUSED`/`SUBSCRIPTION_CANCELLED`).

Esto resuelve la pregunta crítica: _"¿cobré o no?"_ — nunca se decide cobrar dos veces sobre un resultado incierto; se pregunta al proveedor y se **settea el estado definitivo**.

---

## 8. Máquina de estados (`transitions/`)

Todas las transiciones pasan por `assertTransition(entidad, desde, hacia)` usando las tablas permitidas de `transitions.constants.ts`:

**Subscription**: `ACTIVE ⇄ PAUSED`, `ACTIVE → CANCELLED`, `PAUSED → CANCELLED`. **`CANCELLED` no admite salida.**

**Billing Intent**:

- `SCHEDULED → IN_FLIGHT | OMITTED`
- `IN_FLIGHT → SUCCEEDED | FAILED_FINAL | UNKNOWN | RETRY_PENDING`
- `RETRY_PENDING → IN_FLIGHT | OMITTED`
- `UNKNOWN → IN_FLIGHT | SUCCEEDED | RETRY_PENDING | OMITTED`
- `FAILED_FINAL → IN_FLIGHT` (solo vía reprocess manual)
- **`SUCCEEDED` no admite salida** — un cobro confirmado jamás cambia.

**Payment Attempt**: `IN_FLIGHT → SUCCEEDED | FAILED | UNKNOWN`. Terminales no admiten salida.

La BD refuerza con triggers (`*_guard_update`) todos estos invariantes: identidad, monto y moneda inmutables, índices únicos parciales de intent viva, consistencia de `settled_at`/`omitted_reason`.

---

## 9. Ciclo de vida manual: pause, resume, cancel

`subscriptions.lifecycle.service.ts`:

- **Pause** (`POST /:id/pause`): valida que no esté `CANCELLED`; `ACTIVE → PAUSED`; las intents `SCHEDULED | RETRY_PENDING` pasan a `OMITTED` (razón `SUBSCRIPTION_PAUSED`).
- **Resume** (`POST /:id/resume`): solo si está `PAUSED`; `PAUSED → ACTIVE`. El scheduler reconstruirá los ciclos pendientes en el siguiente sweep.
- **Cancel** (`POST /:id/cancel`): `ACTIVE | PAUSED → CANCELLED`; omite las intents vivas restantes (razón `SUBSCRIPTION_CANCELLED`) y registra `CancellationEvent`. Idempotente: cancelar dos veces devuelve el mismo resultado.

Todas utilizan el guard de idempotencia (mismo efecto por key).

---

## 10. Cobro manual de un ciclo (`billing-cycles`)

`POST /subscriptions/:id/billing-cycles/:cycle/charge`:

1. Busca la suscripción (404 si no existe; 409 si no está `ACTIVE`).
2. `getOrCreateIntent` (crea la billing intent del ciclo si no existe, guardando la `origin_idempotency_key`).
3. Ejecuta el cobro en línea con `ChargeExecutorService.execute` (mismo write-ahead que el path automático, sin pasar por la cola).
4. Devuelve el estado final del intent.

---

## 11. Reproceso manual (`reprocess/`)

`POST /subscriptions/:id/billing-cycles/:cycle/reprocess` recupera un intent terminal:

- `probe` (endpoint de vista previa) evalúa elegibilidad:
  - `FAILED_FINAL` → `ELIGIBLE`.
  - `UNKNOWN` → verifica primero con el proveedor; si sigue `UNKNOWN` → `NOT_ELIGIBLE` (no se arriesga otro cobro); si `SUCCEEDED` → `CLOSED_AS_SUCCEEDED`.
  - `SUCCEEDED` u otros → `NOT_ELIGIBLE`.
- `reprocess` reabre el intent a `IN_FLIGHT` (transición permitida), crea un **attempt `MANUAL`** (sin `auto_seq`, no cuenta para el límite de 5) y cobra de inmediato con verificación, dejando el intent en `SUCCEEDED | FAILED_FINAL | UNKNOWN`.

---

## 12. Notificaciones: outbox append-only (`notifications/`)

La tabla `notifications` es un **outbox**: solo se inserta, nunca se modifica ni borra (trigger `RAISE EXCEPTION`). Cada evento apunta al `aggregate_id` (ej. `subscriptionId`). Actualmente emite `CancellationEvent` cuando una suscripción cae por `FAILED_FINAL`. Se consulta vía `GET /notifications/events?type=&aggregateId=`.

Uso típico: un consumidor externo (dashboard, gateways de email) sondea el outbox y procesa eventos sin riesgo de pérdida, incluso si el proceso principal cae tras confirmar el cobro.

---

## 13. Modelo de datos (resumen)

| Tabla                        | Rol principal                | Invariantes clave                                                                                                                              |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptions`              | Contrato de cobro            | `amount`/`currency` inmutables; `CANCELLED` terminal; `cancelled_at` coherente                                                                 |
| `billing_intents`            | Una intención por ciclo      | Máximo 1 intent viva por suscripción (índice parcial); `SUCCEEDED` terminal; `omitted_reason` coherente                                        |
| `payment_attempts`           | Un cobro contra el proveedor | `provider_operation_id` único global; máx 1 `IN_FLIGHT` y 1 `SUCCEEDED` por intent; `AUTO` con `auto_seq` 1–5; `deadline_at` para recuperación |
| `idempotency_operations`     | Deduplicación por key        | `key+generation` único; `PROCESSING`/`SETTLED` con response seteada; TTL 24 h; lease 5 min                                                     |
| `calendar_non_business_days` | Festivos por fecha           | Datos de entrada del calendario                                                                                                                |
| `notifications`              | Outbox de eventos            | Append-only; `CancellationEvent`                                                                                                               |

Migraciones: `src/database/migrations/` (001 → 007). Se aplican con `migration-runner`; **nunca se edita una migración ya aplicada**.

---

## 14. Configuración por entorno

| Variable                         | Default               | Efecto                                                                                        |
| -------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `PORT`                           | `3000`                | Puerto HTTP                                                                                   |
| `MOCK_PAYMENT_SCENARIO`          | `SUCCESS`             | Simula resultado de pasarela: `SUCCESS`, `DECLINED`, `TIMEOUT`, `AMBIGUOUS`, `PROVIDER_ERROR` |
| `EXECUTION_TIMEOUT_MS`           | `60000`               | Deadline del payment attempt                                                                  |
| `CHARGE_DISPATCH_INTERVAL_MS`    | `1000`                | Cadencia del dispatcher                                                                       |
| `DISPATCH_BATCH_SIZE`            | `100`                 | Lote de intents por dispatch                                                                  |
| `RECOVERY_SWEEP_INTERVAL_MS`     | `30000`               | Cadencia del recovery sweep                                                                   |
| `VERIFICATION_SWEEP_INTERVAL_MS` | `5000`                | Cadencia del verification sweep                                                               |
| `ENGINE_DOWN_TOLERANCE_MINUTES`  | `15`                  | Sobrepasa un ciclo que no se agendó a tiempo                                                  |
| `CALENDAR_NON_BUSINESS_WEEKDAYS` | `0,6` (fin de semana) | Días no hábiles de la semana                                                                  |

(Fechas siempre `YYYY-MM-DD`, montos en unidad menor, `timezone` IANA.)

---

## 15. Contra qué protege el diseño

| Escenario                            | Mecanismo                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Doble clic / retry del cliente       | Guard de idempotencia → replay de la respuesta o `409`/`423`                    |
| Dos workers procesan la misma intent | `SELECT ... FOR UPDATE` + índice de intent viva única                           |
| Proceso muere durante el cobro       | write-ahead + recovery sweep (`deadline_at`)                                    |
| Resultado ambiguo del proveedor      | `UNKNOWN` + verification sweep con el proveedor                                 |
| Reintento de un cobro ya confirmado  | Intent `SUCCEEDED` es terminal; el attempt `SUCCEEDED` es único por intent      |
| Suscripción fallida                  | `FAILED_FINAL` → cancelación automática + eventos de outbox                     |
| Motor caído un día de cobro          | `ENGINE_DOWN_TOLERANCE` → ciclo `OMITTED` en vez de cobro "recuperado" indebido |

---

## 16. Cómo ejecutar y probar

```bash
docker compose up -d     # PostgreSQL + Redis
npm run start:dev        # API NestJS

npm run test             # unitarios
npm run test:e2e         # concurrencia e idempotencia
npm run test:cov         # cobertura (core ≥ 90%)
npm run test:trace       # traza RF/INV → tests
npm run lint
```

Referencias: `docs/spec.md` (requisitos), `docs/api-contract.md` (endpoints), `docs/constitution.md` (reglas).
