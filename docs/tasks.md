# Tasks — IdemEngine (v1.2)

Desglose ejecutable de `plan.md` y `spec.md` en tareas de < 30 min, ordenadas por dependencia, con RF/INV y criterio "Hecho cuando:" verificable.

- **T1–T19 están cerradas y no se reescriben.** Lo que necesita corrección se hace con **migraciones y tareas nuevas** (spec §21: nunca se modifica una migración publicada).
- **T20 en adelante es nuevo** (los números pendientes cambian respecto a v1.1).

---

## Decisiones de diseño asumidas (confirmar antes de T20)

La spec deja estos puntos abiertos. Las tareas asumen lo siguiente; T20 lo formaliza en `spec.md` v1.2.

| # | Decisión |
|---|----------|
| D1 | **PostgreSQL es la fuente de verdad de la idempotencia** (tabla `idempotency_operations`). Redis queda como lock opcional de coordinación. |
| D2 | **`SETTLED` por tipo de operación.** Alta, pause, resume y cancel: al commit de la transición (misma transacción). Cobro de ciclo y reprocess: cuando el attempt de esa operación deja `IN_FLIGHT` (`SUCCEEDED`, `FAILED` o `UNKNOWN`); la respuesta refleja el estado de la intent. Enmienda de §3.4, para que una key no quede en 423 indefinido si termina en `UNKNOWN`. |
| D3 | **Lease de `PROCESSING`** (default 5 min). Si el proceso muere antes del commit, la misma key con el mismo payload puede retomarse al vencer el lease. |
| D4 | `billing_cycle` = **fecha nominal** (DATE, antes de desplazar a día hábil). |
| D5 | Existe una **operación externa de cobro de ciclo** (`POST /subscriptions/:id/billing-cycles/:cycle/charge`) que hace get-or-create de la intent. Es la operación que ejercita RF-04 y E2E-03. |
| D6 | **Todo estado ambiguo** (`TIMEOUT`, `AMBIGUOUS`, worker muerto) pasa a `UNKNOWN` y exige `verify` antes de reintentar. Solo `PROVIDER_ERROR` y `TEMPORARY_UNAVAILABLE` con "no cobrado" explícito son reintentables directos. |
| D7 | `providerOperationId` **por attempt, persistido antes de llamar al adapter** (write-ahead). El contrato del mock es: `verify → FAILED` es definitivo y el provider rechaza cualquier `charge` posterior con ese id. |
| D8 | `ATTEMPT_TIMEOUT` = 60 s; el barrido de recuperación corre cada 30 s (configurables). |
| D9 | `UNKNOWN`: re-verificación con backoff (1 m, 2 m, 4 m… tope 1 h). Tras 24 h o 10 verificaciones se marca `needs_manual_review` (sigue bloqueando el ciclo siguiente, pero queda visible). |
| D10 | Intent: se añade el estado `RETRY_PENDING` y `OMITTED` lleva `omitted_reason` (`ENGINE_DOWN`, `SUBSCRIPTION_PAUSED`, `SUBSCRIPTION_CANCELLED`, `OVERLAP`). No hay estado `CANCELLED` de intent. Una suscripción `PAUSED`/`CANCELLED` **no crea** intents (INV-08/09 intactos). |
| D11 | Solapamiento: el ciclo N+1 no se crea mientras N esté viva. Si llega el momento de N+2 y N sigue viva, N+1 se registra `OMITTED(OVERLAP)`. |
| D12 | `FAILED_FINAL` (por agotar 5 attempts **o** por error no reintentable como `DECLINED`) cancela la suscripción y emite `CancellationEvent`. |
| D13 | Reprocess crea attempts `MANUAL` (`auto_seq` nulo), no programa retries automáticos, no reactiva la suscripción y hace `verify` previo sobre `UNKNOWN`. INV-10 aplica solo a attempts `AUTO`. |
| D14 | Umbral de omisión por motor caído: 15 min desde la hora de procesamiento (configurable). 409 tiene prioridad sobre 423. Same-key concurrente responde 423 (no espera). El 423 incluye `Retry-After`. |

Nota: con 5 attempts hay solo 4 esperas (10 s, 20 s, 40 s, 80 s), así que el tope de 1 h nunca se alcanza. Se mantiene como parámetro configurable y se documenta.

---

## Fases 0–3 — Cerradas

- [x] **T1 — Scaffolding.** Infraestructura, sin RF.
- [x] **T2 — CommonModule: Zod + errores.**
- [x] **T3 — Reloj y zona horaria única** (RF-08, RF-23, RF-24).
- [x] **T4 — Hash canónico del payload** (RF-02, RF-03).
- [x] **T5 — Store de idempotencia en Redis.** _Se degrada a coordinación en T26; la fuente de verdad pasa a PG (T23–T25)._
- [x] **T6 — Guard de idempotencia.** _Se refactoriza sobre PG en T25._
- [x] **T7 — Guard sobre una mutación real + concurrencia** (RF-06, RF-07).
- [x] **T8 — Migración `subscriptions`** (RF-08, RF-10).
- [x] **T9 — Alta de suscripción.** _Se pasa por el Guard en T32._
- [x] **T10 — Migración `billing_intents` + `payment_attempts`.** _Se complementa con T27 y T28._
- [x] **T11 — Consulta de suscripción e historial.** _Su cálculo de próxima fecha se unifica en T46; el historial se amplía en T55._
- [x] **T12 — Cancelación de suscripción.** _Se reduce a servicio de dominio en T33; la API llega en T52._
- [x] **T13 — GatewayModule + MockPaymentAdapter.**
- [x] **T14 — providerOperationId + verify.** _Se endurece el contrato en T31._
- [x] **T15 — Clasificación explícita de errores.** _`TIMEOUT` se reclasifica en T30._
- [x] **T16 — ChargeExecutor: exclusividad de ejecución.** _Se ajusta a write-ahead en T35._
- [x] **T17 — Confirmación verificada y estados terminales.**
- [x] **T18 — Interrupción y UNKNOWN.** _Se completa con `deadline_at` y ejecución periódica en T37._
- [x] **T19 — CalendarModule** (RF-23, RF-24, RF-25).

---

## Fase 4 — Decisiones y correcciones de lo cerrado

- [x] **T20 — Spec v1.2: cerrar decisiones** (§3.4, §5, §6, RF-14/16/17/22/29) · Incorporar D1–D14 en `spec.md`: `SETTLED` por tipo, tabla de transiciones de intent y attempt, contrato de `verify`, `TIMEOUT` → `UNKNOWN`, valores de timeouts y cadencias. Corregir además la errata de versión del encabezado y alinear §2.2 con INV-02. Depende de: —. _Hecho cuando:_ el diff de `spec.md` contiene las 14 decisiones y ninguna tarea posterior contradice la spec.

- [x] **T21 — Anexo de endpoints** (RF-01, RF-08, RF-09, RF-26..29) · Tabla con método, ruta, ¿mutación idempotente?, códigos de éxito y error, y formato de error normalizado. Incluye el endpoint de cobro de ciclo (D5) y el de outbox. Depende de: T20. _Hecho cuando:_ cada endpoint de las fases 5–7 aparece en la tabla con sus códigos.

- [x] **T22 — Script de trazabilidad** (§20, const. #9) · Script que lee tags `@RF-xx`, `@INV-xx` y `@E2E-xx` en los tests y lista los que no tienen test. Modo advertencia con archivo `pending.txt` que solo puede reducirse. Depende de: T20. _Hecho cuando:_ corre en CI, falla si `pending.txt` crece y muestra la lista actual de RF/INV sin test.

- [x] **T23 — Migración `idempotency_operations`** (RF-02..05 · INV-05, INV-06) · Columnas: `key`, `generation`, `operation_type`, `payload_hash`, `status` (`PROCESSING|SETTLED`), `response_status`, `response_body`, `billing_intent_id` (nullable), `created_at`, `expires_at`, `lease_expires_at`, `settled_at`. `UNIQUE(key, generation)` y `CHECK (status='SETTLED' ⇒ response no nula)`. Depende de: T3, T20. _Hecho cuando:_ la migración aplica desde cero y los tests de constraints fallan al duplicar `(key, generation)` o al asentar sin respuesta.

- [x] **T24 — IdempotencyRepository sobre PG** (RF-02..05, RF-06, RF-07 · INV-05) · `registerOrGet(key, hash, type)` atómico con `INSERT … ON CONFLICT`. Devuelve `NEW | REPLAY | IN_FLIGHT | MISMATCH | RETAKE`. Si la key expiró (según `Clock`) crea `generation + 1`. Depende de: T4, T23. _Hecho cuando:_ con PG real, 50 llamadas concurrentes same-key dan exactamente un `NEW`, y la expiración se prueba con reloj fijo, sin `sleep`.

- [x] **T25 — Guard sobre PG** (RF-01..07 · INV-05, INV-06) · Refactor de T6: registra `PROCESSING` en su propia transacción, asienta `SETTLED` en la **misma transacción** que el efecto de negocio, retoma tras vencer el lease (D3), responde `409` antes que `423` y añade `Retry-After` al `423`. Depende de: T21, T24, T6. _Hecho cuando:_ los tests de T6/T7 pasan contra PG y un crash entre efecto y asentado no deja `SETTLED` sin efecto ni efecto sin `SETTLED`.

- [x] **T26 — Redis solo como coordinación** (§4) · Reducir el store Redis de T5 a un lock corto (`SET NX PX`) opcional delante del Guard. Ninguna decisión de estado lee de Redis. Depende de: T25. _Hecho cuando:_ con Redis detenido, los tests de idempotencia siguen en verde y `grep` no encuentra lecturas de `idem:*` en la lógica de decisión.

- [x] **T27 — Migración: estados y campos de Billing Intent** (RF-14, RF-16, RF-17, RF-18 · INV-02) · Añade `RETRY_PENDING`, `omitted_reason` (obligatorio si `OMITTED`), `next_attempt_at`, `unknown_since`, `verify_count`, `next_verify_at`, `needs_manual_review`. El único parcial de intent viva incluye `RETRY_PENDING`. Depende de: T10, T20. _Hecho cuando:_ aplica sobre una BD con datos de T10 y los constraints fallan al violarse (por ejemplo `OMITTED` sin motivo).

- [x] **T28 — Migración: Payment Attempts** (RF-19, RF-29 · INV-03, INV-04, INV-10) · Añade `trigger` (`AUTO|MANUAL`), `auto_seq` (nulo si `MANUAL`), `started_at`, `deadline_at`. Reemplaza `CHECK attempt_no 1..5` por `CHECK (trigger='AUTO' AND auto_seq BETWEEN 1 AND 5 OR trigger='MANUAL' AND auto_seq IS NULL)` y `UNIQUE(intent, auto_seq)`. Mantiene `UNIQUE(provider_operation_id)`. Depende de: T10, T20. _Hecho cuando:_ un sexto attempt `MANUAL` se inserta y un sexto `AUTO` es rechazado.

- [x] **T29 — Máquina de estados como código** (§5 · INV-06, INV-07) · Módulo `transitions` con la tabla completa de transiciones de Billing Intent, Payment Attempt y Subscription; todo cambio de estado pasa por él. Depende de: T27, T28. _Hecho cuando:_ un test parametrizado recorre todos los pares estado→estado y solo los permitidos pasan; `SUCCEEDED` no admite salida.

- [x] **T30 — Reclasificar errores ambiguos** (RF-19, RF-20; corrige T15) · `TIMEOUT` y `AMBIGUOUS` salen del catálogo de reintentables directos y producen attempt `UNKNOWN` (D6). `PROVIDER_ERROR` y `TEMPORARY_UNAVAILABLE` siguen siendo reintentables. Depende de: T15, T29. _Hecho cuando:_ los unit tests muestran que `TIMEOUT` y `AMBIGUOUS` nunca disparan un retry sin `verify`.

- [x] **T31 — Contrato del mock: verify definitivo** (RF-15, RF-17 · INV-01, INV-04; corrige T14) · Tras `verify → FAILED`, un `charge` posterior con ese `providerOperationId` es rechazado. Un `charge` repetido con el mismo id nunca duplica el cobro. Depende de: T14. _Hecho cuando:_ la secuencia `charge (respuesta perdida) → verify FAILED → charge` termina rechazada y con cero cobros efectivos extra.

- [x] **T32 — Alta de suscripción bajo el Guard** (RF-01, RF-08; corrige T9) · Cablear el `POST` al Guard de PG (`SETTLED` en la misma transacción del alta). Monto en enteros de unidad menor y divisa ISO 4217. Depende de: T25. _Hecho cuando:_ el alta repetida con la misma key devuelve el `201` original sin crear otra suscripción, sin key devuelve `400`, y monto decimal o divisa fuera de ISO devuelve `400`.

- [x] **T33 — Cancelación como servicio de dominio** (RF-10 · INV-08; ajusta T12) · Servicio `SubscriptionLifecycle.cancel()` que transiciona la suscripción y marca `OMITTED(SUBSCRIPTION_CANCELLED)` las intents `SCHEDULED`/`RETRY_PENDING`, sin tocar un attempt `IN_FLIGHT`. No emite evento ni expone API (eso llega en T43 y T52). Depende de: T12, T27, T29. _Hecho cuando:_ un test de servicio prueba que un `IN_FLIGHT` previo conserva su resultado y que las intents no iniciadas quedan `OMITTED` con motivo.

---

## Fase 5 — Ejecución de cobros

- [x] **T34 — Migración outbox `notifications`** (RF-22, RF-28) · Tabla de eventos de dominio (`id`, `type`, `aggregate_id`, `payload`, `created_at`). Sin transporte externo. Depende de: T20. _Hecho cuando:_ la migración aplica desde cero y se inserta un `CancellationEvent` de prueba.

- [x] **T35 — Executor con write-ahead** (RF-12, RF-13 · INV-01, INV-03, INV-04; ajusta T16/T17) · Secuencia: (1) transacción que bloquea la intent (`FOR UPDATE`), crea el attempt con `providerOperationId` y `deadline_at` y hace commit; (2) llamada al adapter **fuera** de la transacción; (3) segunda transacción que asienta el resultado. Depende de: T28, T29, T31. _Hecho cuando:_ un crash tras el paso 1 deja un attempt `IN_FLIGHT` con su id persistido, y dos transacciones simultáneas sobre la misma intent avanzan solo una.

- [x] **T36 — Resolución de resultado: éxito y ambiguo** (RF-15, RF-16 · INV-07) · `SUCCESS` verificado → attempt e intent `SUCCEEDED`. `TIMEOUT` o `AMBIGUOUS` → attempt e intent `UNKNOWN` con `unknown_since`. Depende de: T30, T35. _Hecho cuando:_ una respuesta local sin confirmación no asienta éxito y una intent `SUCCEEDED` no vuelve a llamar al adapter.

- [x] **T37 — Recuperación periódica de `IN_FLIGHT` vencidos** (RF-16; completa T18) · Barrido cada 30 s sobre attempts `IN_FLIGHT` con `deadline_at < now` → `UNKNOWN`, usando solo datos de PG. Depende de: T36. _Hecho cuando:_ matar el worker tras el write-ahead deja el attempt en `UNKNOWN` al expirar el deadline, sin intervención manual.

- [x] **T38 — Cálculo de backoff** (RF-19) · Función pura: `10 s · 2^n`, jitter ±20 %, tope 1 h, con reloj y aleatoriedad inyectables. Depende de: T3. _Hecho cuando:_ los unit tests validan los rangos de los 4 delays posibles y que el tope funciona aunque no se alcance con 5 attempts.

- [x] **T39 — RetryPolicy: fallos → `RETRY_PENDING` o `FAILED_FINAL`** (RF-19..21 · INV-10) · Error reintentable con `auto_seq < 5` → intent `RETRY_PENDING` con `next_attempt_at` (mismo intent, sin nueva Idempotency Operation). Error no reintentable (`DECLINED`, etc.) o 5º fallo → `FAILED_FINAL`. Depende de: T30, T36, T38. _Hecho cuando:_ el test recorre 5 fallos reintentables y termina en `FAILED_FINAL`, y un `DECLINED` termina en `FAILED_FINAL` sin retry.

- [x] **T40 — Dispatcher PG → BullMQ y worker** (RF-19, RF-30) · Consulta periódica `WHERE next_attempt_at <= now() FOR UPDATE SKIP LOCKED` que encola en `charges.execute` con `jobId` determinista; el worker llama al Executor. BullMQ es solo transporte: si se pierde el job, el barrido lo re-encola. Depende de: T27, T35, T39. _Hecho cuando:_ matar el proceso entre el commit y el encolado no pierde el cobro, y dos jobs duplicados producen un solo attempt.

- [x] **T41 — Verificador de `UNKNOWN`** (RF-17 · INV-04, INV-07) · Llama `verify(providerOperationId)`: `SUCCEEDED` cierra el cobro; `FAILED` habilita nuevo attempt (vía `RETRY_PENDING` si la suscripción está `ACTIVE`, si no `OMITTED` con su motivo); `UNKNOWN` mantiene el estado e incrementa `verify_count`. Depende de: T31, T37. _Hecho cuando:_ una intent `UNKNOWN` no vuelve a llamar a `charge` mientras `verify` devuelva `UNKNOWN`.

- [x] **T42 — Cadencia y escalado de `UNKNOWN`** (RF-16, RF-17, RF-14; D9) · Re-verificación programada con `next_verify_at` (1 m, 2 m, 4 m… tope 1 h). Tras 24 h o 10 verificaciones: `needs_manual_review = true`. Depende de: T41. _Hecho cuando:_ una intent `UNKNOWN` se re-verifica en cadencia y, al cumplirse el umbral, queda marcada para revisión sin cambiar de estado.

- [x] **T43 — Agotamiento: cancelación y evento atómicos** (RF-22, RF-28) · Al pasar a `FAILED_FINAL`: cancelar la suscripción (T33) y persistir `CancellationEvent` en la **misma transacción**. Depende de: T33, T34, T39. _Hecho cuando:_ un fallo simulado a mitad de transacción no deja evento sin cancelación ni cancelación sin evento.

- [x] **T44 — Outbox consultable por API** (§14) · `GET` de eventos de dominio con filtro por tipo y agregado. Depende de: T21, T43. _Hecho cuando:_ el `CancellationEvent` de T43 se recupera por API.

- [x] **T45 — Operación externa de cobro de ciclo** (RF-04, RF-11, RF-12 · INV-02) · `POST /subscriptions/:id/billing-cycles/:cycle/charge` bajo el Guard: get-or-create de la intent por `(subscription_id, billing_cycle)` y solicitud de ejecución. Si la intent ya existe, devuelve su estado actual. `SETTLED` cuando el attempt deja `IN_FLIGHT` (D2). Depende de: T25, T40. _Hecho cuando:_ dos keys distintas para el mismo ciclo generan una sola intent, y una key expirada crea una nueva operación pero no una segunda intent.

---

## Fase 6 — Calendario y scheduling

- [x] **T46 — Ciclo nominal y próxima facturación unificada** (RF-09, RF-23 · INV-02) · Definir `billing_cycle` como fecha nominal (D4) y hacer que la consulta de T11 use el `CalendarModule`, sin duplicar lógica de fechas. Depende de: T19, T27. _Hecho cuando:_ un test compara la próxima fecha de `GET` con la del `CalendarModule` para mensual, anual y fin de mes.

- [x] **T47 — Scheduler: crear intents vencidas** (RF-11, RF-23, RF-24, RF-25, RF-30 · INV-02, INV-08, INV-09) · Identifica ciclos cuya hora de procesamiento llegó, aplica fin de mes y luego día hábil (sin mover el ancla) y crea la intent `SCHEDULED` con `next_attempt_at`. Suscripciones no `ACTIVE` no generan intents. Depende de: T40, T46. _Hecho cuando:_ el despacho repetido no crea intents duplicadas, y anclas día 31 y 29-feb anual dan las fechas esperadas.

- [x] **T48 — Omisión por motor caído** (RF-18, RF-31) · Ciclos vencidos más allá de la tolerancia (D14) se registran `OMITTED(ENGINE_DOWN)`, sin efectos económicos ni catch-up; el siguiente ciclo se calcula desde el ancla. Depende de: T47. _Hecho cuando:_ con el scheduler detenido dos ciclos quedan `OMITTED(ENGINE_DOWN)` y el ciclo siguiente se procesa normalmente.

- [x] **T49 — No solapamiento de ciclos** (RF-14 · INV-01) · Mientras exista una intent viva (`SCHEDULED`, `IN_FLIGHT`, `RETRY_PENDING`, `UNKNOWN`), no se crea la del ciclo siguiente. Si llega el momento de N+2 y N sigue viva, N+1 queda `OMITTED(OVERLAP)` (D11). Depende de: T39, T47. _Hecho cuando:_ con el ciclo N en `RETRY_PENDING`, N+1 no se crea, y se crea cuando N deja de estar viva dentro de su ventana.

---

## Fase 7 — Operaciones administrativas

- [x] **T50 — Admin: Pause** (RF-26 · INV-09) · Mutación con Guard: `ACTIVE → PAUSED`, intents `SCHEDULED`/`RETRY_PENDING` pasan a `OMITTED(SUBSCRIPTION_PAUSED)`, un `IN_FLIGHT` termina y un `UNKNOWN` sigue verificándose sin iniciar cobros nuevos. Depende de: T25, T33, T49. _Hecho cuando:_ en `PAUSED` no se generan intents ni retries, y un attempt en vuelo concluye con su resultado.

- [x] **T51 — Admin: Resume** (RF-27) · Mutación con Guard que solo aplica `PAUSED → ACTIVE`. Sin catch-up: el siguiente cobro es el próximo ciclo de calendario. Depende de: T50. _Hecho cuando:_ tras reanudar no se recuperan fechas perdidas, y resume sobre una suscripción no `PAUSED` devuelve el error definido en T21.

- [x] **T52 — Admin: Cancel (API)** (RF-28) · Mutación con Guard sobre `SubscriptionLifecycle.cancel()` (T33) que emite el `CancellationEvent` en la misma transacción. Depende de: T25, T33, T43. _Hecho cuando:_ repetir la mutación con la misma key no duplica efectos ni eventos, y un attempt `IN_FLIGHT` conserva su resultado.

- [x] **T53 — Reprocess: elegibilidad y verify previo** (RF-29 · INV-07) · Acepta intents `UNKNOWN` y `FAILED_FINAL`. Sobre `UNKNOWN` hace `verify` primero: `UNKNOWN` → rechazo; `SUCCEEDED` → cierra sin cobrar. Rechaza `SUCCEEDED` con el código definido en T21. Depende de: T21, T41. _Hecho cuando:_ reprocess sobre `SUCCEEDED` y sobre `UNKNOWN` no verificable son rechazados sin llamar a `charge`.

- [x] **T54 — Reprocess: ejecución y asentado** (RF-29 · INV-02) · Crea un attempt `MANUAL` sobre la misma intent, sin programar retries automáticos. Asienta la operación cuando el attempt termina (D2). No reactiva una suscripción `CANCELLED`. Depende de: T25, T35, T53. _Hecho cuando:_ un reprocess exitoso sobre `FAILED_FINAL` deja la intent `SUCCEEDED` y la suscripción `CANCELLED`, sin nueva intent.

- [x] **T55 — Consulta de historial ampliada** (RF-09) · `GET` incluye `omitted_reason`, `trigger` de cada attempt, motivos de fallo y `needs_manual_review`. Depende de: T11, T42. _Hecho cuando:_ el `GET` muestra el historial completo con todos los campos anteriores.

---

## Fase 8 — E2E y cierre

- [x] **T56 — e2e idempotencia y concurrencia** (E2E-01..04; RF-01..07) · Requests concurrentes reales contra PG real. E2E-01 se formula como "todas las requests convergen al mismo resultado asentado" (D14). E2E-03 usa el endpoint de T45. Depende de: T32, T45. _Hecho cuando:_ E2E-01..04 pasan en verde.

- [x] **T57 — e2e cobros, ambiguo y `UNKNOWN`** (E2E-05, E2E-06, E2E-07; RF-15..17) · E2E-05: `TIMEOUT` → `UNKNOWN` → `verify FAILED` → nuevo attempt según backoff. E2E-06 mata el worker y reinicia. Depende de: T37, T42. _Hecho cuando:_ los tres pasan y nunca hay un segundo cobro efectivo.

- [x] **T58 — e2e retries y agotamiento** (E2E-08, E2E-09; RF-19..22) · Cinco fallos reintentables con delays esperados, `DECLINED` sin retry y evento persistido. Depende de: T43, T44. _Hecho cuando:_ E2E-08 y E2E-09 pasan.

- [x] **T59 — e2e calendario, motor caído y solapamiento** (E2E-10, E2E-15, E2E-16; RF-14, RF-18, RF-23..25, RF-31) · Sin catch-up, con solapamiento bloqueado y fin de mes con día hábil. Depende de: T48, T49. _Hecho cuando:_ E2E-10, E2E-15 y E2E-16 pasan.

- [x] **T60 — e2e admin y cancelación en vuelo** (E2E-11, E2E-12, E2E-13, E2E-14; RF-26..29) · Pause, resume sin catch-up, cancel durante `IN_FLIGHT` y reprocess sin reactivar. Depende de: T51, T52, T54. _Hecho cuando:_ E2E-11..14 pasan.

- [x] **T61 — Puertas de calidad** (const. #9, #10, #12; §18) · Cobertura ≥ 90 % por artefacto (Guard ↔ RF-01..07; Executor ↔ RF-12..17, RF-29; Scheduler/Calendar ↔ RF-14, RF-18, RF-23..25, RF-30, RF-31), `pending.txt` de T22 vacío, lint/prettier y revisión final de migraciones (reproducibles desde cero). Depende de: T22, T55, T56..T60. _Hecho cuando:_ el informe ≥ 90 %, cada RF e INV traza a un test y `npm run test`, `test:e2e` y `lint` están en verde.