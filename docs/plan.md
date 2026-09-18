# Plan — IdemEngine (v1.1)

Plan de implementación para la spec **v1.1**. Sin código: módulos, modelo de datos, decisiones justificadas con su alternativa descartada y estrategia de tests. Cada bloque indica qué **RF** cubre.

## 0. Principio rector

El sistema asume que cualquier request puede repetirse, cualquier job puede ejecutarse más de una vez y cualquier proceso puede morir en cualquier momento (§22). La garantía no descansa en entregas "exactly once" sino en la composición de: idempotencia + identidad de dominio + constraints de PostgreSQL + transacciones + row locking + identidad de operación del provider + máquina de estados explícita + recuperación. **RF-01..RF-31, INV-01..INV-10.**

## 1. Arquitectura (tres capas)

- **API** · Controllers delgados + validación Zod en el borde + mapeo de errores normalizado. Sin lógica de negocio.
- **Dominio** · Guard de idempotencia, executor de cobros, schedulers y máquinas de estado. Es donde viven los invariantes.
- **Infraestructura** · Repositorios PostgreSQL, store Redis, colas BullMQ y `MockPaymentAdapter` detrás de un contrato.

## 2. Módulos

- **CommonModule** · Pipeline de validación Zod, DTOs e interfaces explícitas, reloj oficial, mapeo de errores (constitución #5/#6). Es la puerta de entrada de **todos los RF**.
- **IdempotencyModule** · Guard + store Redis `idem:<key>` con TTL de 24 h y estados `PROCESSING|SETTLED`; key obligatoria/global/max 255, hash canónico del DTO, replay de la respuesta asentada, `400` sin key, `409` por payload distinto y `423` en vuelo. **RF-01, RF-02, RF-03, RF-04, RF-05, RF-06, RF-07 · INV-05, INV-06.**
- **SubscriptionsModule** · Alta validada (monto y divisa fijos, `startDate`, frecuencia, timezone), consulta de estado/próxima facturación/historial y cancelación que impide nuevas intenciones, detiene retries y omite las no iniciadas. **RF-08, RF-09, RF-10 · INV-08, INV-09.**
- **BillingModule** · Identidad de negocio `(subscription_id, billing_cycle)`, generación y ciclo de vida de la Billing Intent, y bloqueo de solapamiento de ciclos. **RF-11, RF-12, RF-14 · INV-01, INV-02.**
- **GatewayModule** · Contrato `IPaymentGateway` + `MockPaymentAdapter` con modos `SUCCESS/DECLINED/TIMEOUT/AMBIGUOUS/PROVIDER_ERROR`, `providerOperationId` estable y operación `verify`. **RF-15, RF-17, RF-20 · INV-04.**
- **ChargeExecutorModule** · Ejecución exclusiva de un Payment Attempt (`SELECT … FOR UPDATE`), transiciones de estado, confirmación verificada contra la pasarela, materialización de interrupción y reproceso manual. **RF-12, RF-13, RF-15, RF-16, RF-17, RF-29 · INV-01, INV-03, INV-07.**
- **RetryModule** · Retry interno sobre la misma Billing Intent: backoff `10 s·2ⁿ` + jitter ±20 %, tope 1 h, máximo 5 attempts y agotamiento → `FAILED_FINAL`. **RF-19, RF-20, RF-21, RF-22 · INV-10.**
- **CalendarModule** · Días no hábiles configurables, zona horaria única, siguiente día hábil (evaluado al procesar) y truncamiento de fin de mes/año. **RF-23, RF-24, RF-25.**
- **SchedulerModule** · Despacho por cadencia desde el ancla (sin drift, sin catch-up), gating por estado de suscripción y materialización de `OMITTED` cuando el motor estuvo caído. **RF-18, RF-26, RF-30, RF-31.**
- **AdminModule** · `PAUSE`, `RESUME`, `CANCEL` y `REPROCESS` como mutaciones idempotentes con el mismo guard; consulta de cobros interrumpidos/fallidos. **RF-26, RF-27, RF-28, RF-29.**
- **NotificationsModule** · Outbox de eventos de dominio (`CancellationEvent`) persistido en la transacción que lo origina y consultable por API. **RF-22, RF-28.**
- **HealthModule** · Liveness de PostgreSQL y Redis (infraestructura, sin RF; ya implementado en T1).

## 3. Modelo de datos (PostgreSQL como fuente de verdad)

### 3.1. Tablas

- **`subscriptions`** · `id`, `amount`, `currency`, `frequency` (`daily|weekly|monthly|annual`), `anchor_date`, `timezone`, `status` (`ACTIVE|PAUSED|CANCELLED`), `created_at`, `cancelled_at`. Estados y transiciones de §5.3. **RF-08, RF-09, RF-10, RF-23, RF-26, RF-27, RF-28 · INV-08, INV-09.**
- **`billing_intents`** · `id`, `subscription_id`, `billing_cycle`, `schedule_date`, `amount`, `currency`, `status` (`SCHEDULED|IN_FLIGHT|SUCCEEDED|FAILED_FINAL|UNKNOWN|OMITTED`), `origin_idempotency_key`, `created_at`, `settled_at`. La key de origen es trazable pero no identifica al cobro. **RF-11, RF-12, RF-14, RF-18, RF-29 · INV-01, INV-02, INV-06, INV-07.**
- **`payment_attempts`** · `id`, `billing_intent_id`, `attempt_no`, `provider_operation_id`, `status` (`IN_FLIGHT|SUCCEEDED|FAILED|UNKNOWN`), `error_type`, `started_at`, `finished_at`. **RF-12, RF-13, RF-15, RF-16, RF-17, RF-19, RF-20, RF-21, RF-29 · INV-03, INV-04, INV-10.**
- **`notifications`** (outbox) · `id`, `type` (`CancellationEvent`), `subscription_id`, `billing_intent_id`, `payload`, `status` (`PENDING|PUBLISHED`), `created_at`. **RF-22, RF-28.**
- **`calendar_non_business_days`** · `date` (PK), `reason`. **RF-24.**

### 3.2. Constraints que materializan invariantes

- `UNIQUE (subscription_id, billing_cycle)` en `billing_intents` → **INV-02** (una sola Billing Intent por ciclo).
- Índice único parcial sobre `billing_intents(subscription_id)` para estados vivos (`SCHEDULED`, `IN_FLIGHT`, `UNKNOWN`; retry pendiente = `SCHEDULED`) → **RF-14, INV-01** (sin solapamiento de ciclos).
- `UNIQUE (billing_intent_id, attempt_no)` y `CHECK (attempt_no BETWEEN 1 AND 5)` → **INV-10**.
- `UNIQUE (provider_operation_id)` → **INV-04** (un attempt nunca cambia de identidad de operación).
- Índice único parcial de `payment_attempts(billing_intent_id)` donde `status = IN_FLIGHT` → **INV-03** (un solo attempt en vuelo).
- Transición `SUCCEEDED` nunca revierte: impuesta en el dominio y verificada por constraints de estado. **INV-06, INV-07.**

### 3.3. Redis / BullMQ (coordinación, no verdad de negocio)

- **Store de idempotencia** · `idem:<key>` → `{ payloadHash, state, response, billingIntentRef }` con TTL 24 h sin gracia. **RF-01..RF-07 · INV-05.**
- **Colas** · `charges.schedule` (intenciones), `charges.retry` (nuevos attempts con delay = backoff) y `charges.verify` (verificación/reconciliación tras `UNKNOWN`). **RF-14, RF-17, RF-19, RF-21, RF-22, RF-30, RF-31.**
- **Lock complementario** · `lock:billing:<intentId>` como refuerzo; nunca sustituye `FOR UPDATE` ni los constraints. **RF-13.**

Regla dura: Redis jamás decide si un cobro ocurrió, si una intención existe o si una operación está asentada (§4).

## 4. Decisiones justificadas (alternativa descartada)

1. **Tres identidades separadas** (Idempotency Operation / Billing Intent / Payment Attempt) — *Elegido:* el cobro se identifica por `(subscription_id, billing_cycle)` y sobrevive a la expiración de la key y a los retries. *Descartado:* usar la idempotency-key como identidad del cobro (la expiración de la key o un nuevo attempt romperían la unicidad). **RF-04, RF-11, RF-21 · INV-02.**
2. **Namespace global de keys** — *Elegido:* la key sola identifica la operación; una key no se reutiliza para otra operación en su ventana. *Descartado:* `method + route + key` (permitiría la misma key en endpoints distintos, violando §3.1). **RF-01, RF-07 · INV-05.**
3. **TTL fijo de 24 h sin período de gracia, en Redis** — *Elegido:* expiración natural y ventana única y simple. *Descartado:* expiración en PostgreSQL con limpieza programada (sin TTL nativo) y ventana con gracia (contradice §3.2). **RF-04.**
4. **Idempotencia en Redis; verdad económica en PostgreSQL** — *Elegido:* el guard coordina, pero la unicidad y el estado terminal los imponen constraints, transacciones y row locking. *Descartado:* tratar Redis como fuente de verdad (un reinicio o flush perdería la garantía; §4 lo prohíbe). **RF-02, RF-06, RF-07, RF-12 · INV-01, INV-02.**
5. **Hash canónico del DTO validado por Zod** — *Elegido:* solo campos semánticos, sin orden ni whitespace, con tipos normalizados. *Descartado:* hash del JSON crudo (falsos `409` por reordenamiento, espacios o `"1"` vs `1`). **RF-02, RF-03.**
6. **Replay exacto de la respuesta asentada** — *Elegido:* una key `SETTLED` con mismo payload devuelve la misma respuesta sin re-ejecutar. *Descartado:* recomputar o reenviar al adapter (violaría RF-02 y ejecutaría el adapter de nuevo). **RF-02 · INV-07.**
7. **Retry interno exento del dedupe externo** — *Elegido:* el retry conserva la Billing Intent, crea un nuevo attempt y no pasa por el TTL de la key. *Descartado:* reintentar vía la API pública (moriría en el guard con `423` o generaría una intención nueva). **RF-21 · INV-01.**
8. **Exclusividad con `SELECT … FOR UPDATE` + índice único parcial** — *Elegido:* bloqueo pesimista en la fila del intent, que espera y protege la transacción. *Descartado:* optimistic locking (empuja el reintento al cliente, frágil con colas) y lock Redis como única red (no protege la transacción de PostgreSQL). **RF-13 · INV-03.**
9. **Identidad de operación del provider (`providerOperationId`) + `verify`** — *Elegido:* el mismo intento reutiliza la misma identidad y, ante ambigüedad, se consulta antes de re-ejecutar. *Descartado:* generar un id nuevo por reintento o confiar solo en la respuesta síncrona (produciría un segundo cobro efectivo). **RF-15, RF-17 · INV-04, INV-07.**
10. **La confirmación verificada es la única fuente de éxito** — *Elegido:* un timeout/ambigüedad deja `UNKNOWN` y nunca marca éxito local. *Descartado:* tomar la respuesta local como terminal (éxito fantasma o cobro duplicado al reintentar). **RF-15, RF-16, RF-17.**
11. **Clasificación explícita de errores** — *Elegido:* catálogo cerrado y ampliable de reintentables (`TIMEOUT`, `PROVIDER_ERROR`, `TEMPORARY_UNAVAILABLE`) y no reintentables (`DECLINED`, `INVALID_PAYMENT`, `INVALID_AMOUNT`, `CANCELLED_SUBSCRIPTION`). *Descartado:* inferir por código HTTP o por texto del provider (deja errores sin clasificar y reintenta lo definitivo). **RF-19, RF-20.**
12. **Reintentos acotados: 5 attempts, `10 s·2ⁿ`, jitter ±20 %, tope 1 h** — *Elegido:* exponencial, verificable en e2e y conforme a constitución #7. *Descartado:* reintentos indefinidos (el agotamiento nunca dispara) e intervalo fijo (no es exponencial). **RF-19, RF-22 · INV-10.**
13. **Cadencia calculada desde el ancla, sin catch-up** — *Elegido:* cada ciclo se deriva del ancla; un ciclo omitido no desplaza el futuro. *Descartado:* calcular desde la última ejecución (drift acumulado) y recuperar ciclos perdidos (explícitamente fuera de alcance). **RF-23, RF-31.**
14. **Día no hábil y fin de mes se aplican al procesar, en ese orden** — *Elegido:* primero la fecha de calendario (con truncamiento a último día del mes destino), después el desplazamiento a día hábil; el ancla no cambia. *Descartado:* desplazar a día hábil antes del truncamiento (produciría fechas fuera del mes de calendario). **RF-23, RF-24, RF-25.**
15. **Outbox persistido en la misma transacción** — *Elegido:* el `CancellationEvent` es durable y consultable por API, listo para un transporte futuro. *Descartado:* envío directo a un consumidor o log efímero (no durable y no consultable). **RF-22, RF-28.**
16. **Administración como mutaciones idempotentes con el mismo guard** — *Elegido:* un doble envío de `PAUSE/RESUME/CANCEL/REPROCESS` no duplica efectos. *Descartado:* endpoints admin sin key (un doble clic duplicaría o reintentaría efectos). **RF-26, RF-27, RF-28, RF-29.**
17. **`PAUSE` suspende solo lo no iniciado; `RESUME` sin catch-up** — *Elegido:* el attempt `IN_FLIGHT` termina y su resultado se conserva aunque la suscripción cambie de estado. *Descartado:* abortar el attempt en vuelo (pérdida de resultado económico) y hacer catch-up al reanudar (prohibido). **RF-10, RF-26, RF-27.**
18. **`REPROCESS` mantiene la Billing Intent y no reactiva la suscripción ni el backoff** — *Elegido:* reusa la identidad lógica del cobro sobre `UNKNOWN`/`FAILED_FINAL`. *Descartado:* crear una Billing Intent nueva (violaría INV-02) y reactivar la suscripción automáticamente (violaría RF-10/RF-29). **RF-29 · INV-02 · E2E-14.**
19. **Mock con cinco modos deterministas** — *Elegido:* `SUCCESS/DECLINED/TIMEOUT/AMBIGUOUS/PROVIDER_ERROR` permiten ejercitar verificación, interrupción y clasificación. *Descartado:* mock de solo éxito (dejaría sin cubrir RF-15/17 y los E2E de ambigüedad). **RF-15, RF-17, RF-20.**

## 5. Estrategia de tests

### 5.1. Unit (lógica pura con fakes)
- **Hash canónico** · igualdad bajo reordenamiento/espacios/tipos y detección de cambio de monto. **RF-02, RF-03.**
- **Guard de idempotencia** (con store fake) · `400` sin key, `409` por mismatch, `423` en vuelo, replay `SETTLED`. **RF-01..RF-05 · INV-05, INV-06.**
- **Backoff y clasificación** · delays dentro de rango por jitter y tope; 5º attempt cierra reintentos; cada `error_type` mapea a reintentable/no reintentable. **RF-19, RF-20 · INV-10.**
- **Máquinas de estado** · transiciones permitidas/prohibidas de Billing Intent, Payment Attempt y Subscription; `SUCCEEDED` nunca revierte. **RF-12, RF-13, RF-16, RF-29 · INV-01, INV-03, INV-06, INV-07.**
- **Adaptador mock** · cada modo mapea al resultado correcto y `providerOperationId` no produce doble cobro. **RF-15, RF-20 · INV-04.**
- **Calendario** · día hábil/no hábil (incl. cruce de mes), truncamiento `31→28/29` y `Feb-29` en año no bisiesto, cadencia sin drift tras un omitido. **RF-23, RF-24, RF-25.**

### 5.2. Integración (PostgreSQL y Redis reales, workers BullMQ reales)
- **Idempotencia** · TTL 24 h real (incluido el borde) y concurrencia same-key con requests reales. **RF-01..RF-07 · INV-05.**
- **Suscripciones** · alta válida, rechazo de fecha pasada/inválidos, historial y cancelación de pendientes. **RF-08, RF-09, RF-10 · INV-08, INV-09.**
- **Executor** · dos transacciones simultáneas sobre la misma fila (solo una avanza) y verificación que cierra `UNKNOWN`. **RF-12, RF-13, RF-15, RF-17 · INV-01, INV-03, INV-04.**
- **Ciclos y recuperación** · no solapamiento de ciclos vivos, interrupción materializada y `OMITTED` sin catch-up. **RF-14, RF-16, RF-18, RF-31.**
- **Retries y outbox** · 5 attempts con delays esperados, agotamiento → `FAILED_FINAL` + `CANCELLED` + evento persistido. **RF-19, RF-20, RF-21, RF-22, RF-28 · INV-10.**
- **Admin** · pausa (sin nuevas intenciones, sin retries pendientes, `IN_FLIGHT` termina), reanudación sin catch-up, cancelación y reproceso. **RF-26, RF-27, RF-28, RF-29.**
- **Calendario aplicado** · fin de mes y día hábil end-to-end sobre datos reales. **RF-24, RF-25.**

### 5.3. e2e (contenedores, requests concurrentes reales)
Mapeo de los **16 escenarios** de la spec a RF:

| E2E | Escenario | RF / INV |
|---|---|---|
| E2E-01 | Same key concurrente | RF-02, RF-06, RF-12 · INV-01, INV-05 |
| E2E-02 | Same key / different payload | RF-03, RF-07 |
| E2E-03 | Key expirada | RF-04, RF-11 · INV-02 |
| E2E-04 | Key en vuelo | RF-05, RF-06 |
| E2E-05 | Timeout | RF-19, RF-20, RF-21 |
| E2E-06 | Respuesta ambigua + verify | RF-15, RF-16, RF-17 · INV-04, INV-07 |
| E2E-07 | UNKNOWN aún no verificable | RF-12, RF-17 |
| E2E-08 | Cinco retries | RF-19, RF-22, RF-28 · INV-10 |
| E2E-09 | No retry de error definitivo | RF-20, RF-21 |
| E2E-10 | Motor caído | RF-18, RF-23, RF-31 |
| E2E-11 | Pause | RF-26 · INV-09 |
| E2E-12 | Resume | RF-23, RF-27 |
| E2E-13 | Cancel durante IN_FLIGHT | RF-10, RF-15, RF-28 |
| E2E-14 | Reprocess FAILED_FINAL | RF-29 |
| E2E-15 | Solapamiento de ciclos | RF-14 |
| E2E-16 | Fin de mes | RF-24, RF-25 |

La interrupción (E2E-06, E2E-10) se reproduce matando el worker entre el registro y la respuesta y reiniciándolo. Todos los escenarios de concurrencia usan requests concurrentes reales; las pruebas críticas usan PostgreSQL/Redis reales y workers BullMQ reales (§18).

### 5.4. Puertas de calidad y trazabilidad
- **Cobertura ≥ 90 % por artefacto** (constitución #12): Guard ↔ RF-01..07; Executor ↔ RF-12, RF-13, RF-15, RF-16, RF-17, RF-29; Scheduler/Calendar ↔ RF-14, RF-18, RF-23, RF-24, RF-25, RF-30, RF-31.
- **Matriz de trazabilidad** · cada RF y cada INV-01..INV-10 mapeado a al menos un test, mantenida junto al código (§20).
- **Migraciones inmutables** · toda modificación estructural es una migración nueva, reproducible desde cero (§21, constitución #10).
- **Regla de oro** · `npm run test`, `npm run test:e2e` y `npm run lint` en verde antes de commit (constitución #9, §18).

El desglose ejecutable de este plan (tareas cortas, con RF y criterio "Hecho cuando:") vive en [`tasks.md`](tasks.md).
