# Spec — IdemEngine (v1.2)

> Rev v1.2 — Cierra las decisiones D1–D14 de `tasks.md`: PostgreSQL como fuente de verdad de la idempotencia (tabla `idempotency_operations`); `SETTLED` por tipo de operación; lease de `PROCESSING`; `billing_cycle` nominal; operación externa de cobro de ciclo; reclasificación de `TIMEOUT`/`AMBIGUOUS` → `UNKNOWN`; write-ahead de `providerOperationId`; timeouts y cadencias concretos; estado `RETRY_PENDING` y `OMITTED` con motivo; sin solapamiento con `OMITTED(OVERLAP)`; `FAILED_FINAL` por agotamiento o error no reintentable; reprocess con attempts `MANUAL`; umbral de motor caído y prioridad 409/423.

---

# 1. Propósito (POR QUÉ)

IdemEngine es un motor de cobranza recurrente e idempotente.

Su razón de ser es poder **cobrar a una cadencia programada sin producir más de un cobro efectivo por intención de facturación**, incluso cuando existen:

* peticiones externas duplicadas;
* requests concurrentes;
* reintentos automáticos;
* reintentos manuales;
* jobs duplicados;
* timeouts;
* pérdida de respuestas;
* reinicios del worker.

El sistema expone una API para suscripciones, cobros y operaciones administrativas, además de workers para ejecución asíncrona.

El dashboard operativo queda fuera de alcance de esta versión.

---

# 2. Modelo conceptual

El dominio distingue explícitamente tres niveles:

## 2.1. Idempotency Operation

Representa una **operación externa solicitada por un cliente**.

Se identifica por:

```text
Idempotency-Key
```

Una misma key dentro de su ventana sólo puede representar una única operación lógica.

---

## 2.2. Billing Intent

Representa el **cobro lógico de una suscripción para un ciclo de facturación concreto**.

Una Billing Intent es independiente de la Idempotency-Key utilizada para crearla.

Su identidad de negocio es:

```text
(subscription_id, billing_cycle)
```

que materializa la invariante **INV-02**: una combinación `(subscription_id, billing_cycle)` puede tener como máximo una Billing Intent (única por suscripción y ciclo).

`billing_cycle` es la **fecha nominal** del ciclo (D4): un `DATE` del calendario de la suscripción, **antes** de cualquier desplazamiento por día no hábil o truncamiento de fin de mes. La fecha efectiva de procesamiento se deriva después con `CalendarModule`; nunca forma parte de la identidad.

Una suscripción no podrá tener más de una Billing Intent para el mismo ciclo.

La expiración de una Idempotency-Key nunca permitirá crear una segunda Billing Intent para un ciclo que ya tenga una intención viva o asentada; **INV-02** se impone en PostgreSQL.

---

## 2.3. Payment Attempt

Representa una ejecución concreta de una Billing Intent contra el Payment Adapter.

Una Billing Intent puede tener múltiples Payment Attempts:

```text
Billing Intent #123

Attempt #1 → timeout
Attempt #2 → declined
Attempt #3 → success
```

Todos los attempts pertenecen al mismo cobro lógico.

Un Payment Attempt nunca crea una Billing Intent adicional.

---

# 3. Decisiones base

## 3.1. Idempotency-Key

Toda mutación externa deberá incluir:

```http
Idempotency-Key: <value>
```

La key:

* es obligatoria;
* no puede estar vacía;
* máximo 255 caracteres;
* se compara de forma exacta;
* pertenece a un espacio global de keys.

La identidad de una operación idempotente es:

```text
Idempotency-Key
```

No se utilizará:

```text
HTTP method + route + key
```

como namespace.

Por tanto, una key usada para una operación no podrá reutilizarse para otra operación distinta durante su ventana.

---

## 3.2. Ventana de idempotencia

La fuente de verdad de la idempotencia es **PostgreSQL**: la tabla `idempotency_operations` persiste cada operación con `key`, `generation`, `operation_type`, `payload_hash`, `status` y respuesta asentada (D1). Redis queda como lock opcional de coordinación y jamás decide el estado.

La ventana es un TTL fijo de:

```text
24 horas
```

El TTL comienza en el primer registro durable de la key.

No existe período de gracia.

La unicidad es `UNIQUE(key, generation)`. Una vez expirado el TTL, la key podrá representar una operación nueva con `generation + 1` y un registro nuevo.

El vencimiento de una key **no elimina ni invalida el historial de la operación ni su Billing Intent asociada**.

---

## 3.3. Payload canónico

La comparación de payload se realiza sobre el DTO validado por Zod.

El payload canónico:

* contiene únicamente campos semánticamente relevantes;
* ignora orden de propiedades;
* ignora diferencias de whitespace no semántico;
* representa valores con tipos normalizados;
* se serializa de forma determinista;
* genera un hash persistido.

La comparación será:

```text
same key + same canonical payload
    → mismo resultado

same key + distinto canonical payload
    → 409 Conflict
```

---

## 3.4. Estado de la Idempotency Operation

Cada operación externa se registra con su `operation_type` (por ejemplo `SUBSCRIPTION_CREATE`, `SUBSCRIPTION_PAUSE`, `SUBSCRIPTION_RESUME`, `SUBSCRIPTION_CANCEL`, `BILLING_CYCLE_CHARGE`, `BILLING_INTENT_REPROCESS`).

Una operación externa puede estar:

```text
PROCESSING
SETTLED
```

### `SETTLED` por tipo de operación

`SETTLED` depende del tipo de operación (D2):

* **Alta, pause, resume y cancel** — la operación se asienta en el commit de la transición de negocio, dentro de la **misma transacción PG** que persiste el efecto.
* **Cobro de ciclo y reprocess** — la operación se asienta cuando el Payment Attempt de esa operación deja `IN_FLIGHT` (`SUCCEEDED`, `FAILED` o `UNKNOWN`). La respuesta refleja el estado de la Billing Intent en ese momento.

Un resultado local no confirmado no se considera `SETTLED`. Con esta enmienda de §3.4, una key cuyo cobro termina en `UNKNOWN` **no** queda en `423` indefinido: se asienta con la respuesta del estado.

### Lease de `PROCESSING`

Un registro `PROCESSING` lleva un lease con `lease_expires_at`, por defecto **5 minutos** (configurable) (D3). Si el proceso muere antes del commit del `SETTLED`, la misma key con el mismo payload puede retomarse cuando el lease vence.

---

## 3.5. Respuesta de dedupe

Cuando una key `SETTLED` recibe nuevamente el mismo payload dentro de la ventana:

* no se crea una nueva Billing Intent;
* no se crea un nuevo Payment Attempt;
* no se ejecuta el Payment Adapter;
* se devuelve exactamente la respuesta HTTP previamente asentada.

---

## 3.6. Operación en vuelo

Si la key existe, está dentro de la ventana y la operación todavía no está `SETTLED` (y el lease no ha vencido):

```http
423 Locked
```

La respuesta deberá incluir como mínimo:

```json
{
  "error": "IDEMPOTENCY_LOCKED",
  "status": "PROCESSING"
}
```

y el header `Retry-After` con los segundos restantes del lease. No deberá iniciar otra ejecución.

Reglas de concurrencia y prioridad (D14):

* **Same-key concurrente** responde `423` (no espera).
* El **`409` por payload distinto tiene prioridad sobre el `423`**: si el payload ya difiere, se responde el conflicto aunque la operación siga en vuelo.

---

# 4. Fuente de verdad y coordinación

PostgreSQL es la **fuente de verdad del estado de negocio**, incluida la idempotencia (D1): la tabla `idempotency_operations` decide si una operación está `PROCESSING`, es `SETTLED`, puede retomarse tras vencer el lease o debe crearse con otra `generation`.

Redis/BullMQ se utiliza para:

* coordinación;
* scheduling;
* delayed jobs;
* retries;
* ejecución asíncrona.

Redis no será utilizado como fuente definitiva para determinar:

* si un cobro ocurrió;
* si una Billing Intent existe;
* si una operación está asentada;
* si una suscripción está cancelada;
* si una Payment Attempt tuvo éxito.

La garantía definitiva de consistencia deberá descansar en PostgreSQL mediante:

* transacciones;
* unique constraints;
* row locking;
* estados persistidos.

El Redis Guard es un mecanismo complementario de coordinación (lock corto `SET NX PX`) y no sustituye las garantías de PostgreSQL. Ninguna decisión de estado lee de Redis.

---

# 5. Estados

## 5.1. Billing Intent

Estados:

```text
SCHEDULED
    ├── RETRY_PENDING
    ├── IN_FLIGHT
    └── OMITTED

RETRY_PENDING
    └── IN_FLIGHT

IN_FLIGHT
    ├── SUCCEEDED
    ├── FAILED_FINAL
    └── UNKNOWN
```

Semántica:

* `FAILED_FINAL` significa que el intento automático agotó sus retries **o** que un error no reintentable (`DECLINED`, etc.) terminó el cobro (D12).
* `UNKNOWN` significa que no existe confirmación verificable del resultado económico.
* `RETRY_PENDING` indica un retry automático programado (`next_attempt_at`); es un estado **vivo** a efectos de solapamiento (D10).
* `OMITTED` lleva obligatoriamente `omitted_reason`, con valores `ENGINE_DOWN`, `SUBSCRIPTION_PAUSED`, `SUBSCRIPTION_CANCELLED` o `OVERLAP` (D10). No existe estado `CANCELLED` de intent.

Una Billing Intent `SUCCEEDED` nunca podrá volver a un estado no terminal (INV-07).

Estados **vivos** a efectos de RF-14 (no solapamiento): `SCHEDULED`, `IN_FLIGHT`, `RETRY_PENDING`, `UNKNOWN`.

### Transiciones de Billing Intent

| De | A | Condición |
|---|---|---|
| `SCHEDULED` | `IN_FLIGHT` | el executor gana la exclusividad (`FOR UPDATE`) |
| `SCHEDULED` | `OMITTED` | con `omitted_reason` (pausa, cancelación, solapamiento o motor caído) |
| `IN_FLIGHT` | `SUCCEEDED` | confirmación verificable del provider |
| `IN_FLIGHT` | `FAILED_FINAL` | 5º fallo automático o error no reintentable (D12) |
| `IN_FLIGHT` | `UNKNOWN` | `TIMEOUT`, `AMBIGUOUS` o worker muerto (D6, D8) |
| `IN_FLIGHT` | `RETRY_PENDING` | error reintentable con `auto_seq < 5` (T39) |
| `RETRY_PENDING` | `IN_FLIGHT` | llega `next_attempt_at` |
| `RETRY_PENDING` | `OMITTED` | con `omitted_reason` (pausa o cancelación) |
| `UNKNOWN` | `SUCCEEDED` | `verify` confirma el cobro |
| `UNKNOWN` | `RETRY_PENDING` | `verify → FAILED` con suscripción `ACTIVE` |
| `UNKNOWN` | `OMITTED` | `verify → FAILED` con suscripción no `ACTIVE` |
| `SUCCEEDED` | — | no admite salida (INV-07) |

---

## 5.2. Payment Attempt

Estados:

```text
IN_FLIGHT
    ├── SUCCEEDED
    ├── FAILED
    └── UNKNOWN
```

Cada attempt tiene `trigger` (`AUTO` por retry programado, `MANUAL` por reprocess), `auto_seq` (1..5 para `AUTO`; `NULL` para `MANUAL`), `started_at` y `deadline_at`.

* `UNKNOWN` significa que la ejecución no produjo una confirmación verificable.
* `TIMEOUT` y `AMBIGUOUS` producen attempt `UNKNOWN`, nunca un retry directo (D6).
* El `providerOperationId` del attempt se persiste **antes** de llamar al adapter (write-ahead, D7).
* El vencimiento de `deadline_at` (por defecto 60 s, D8) materializa el attempt como `UNKNOWN` vía barrido de recuperación.

### Transiciones de Payment Attempt

| De | A | Condición |
|---|---|---|
| `IN_FLIGHT` | `SUCCEEDED` | confirmación verificable |
| `IN_FLIGHT` | `FAILED` | error clasificado |
| `IN_FLIGHT` | `UNKNOWN` | `TIMEOUT`, `AMBIGUOUS` o `deadline_at` vencido (D6, D8) |
| `SUCCEEDED`/`FAILED`/`UNKNOWN` | — | no admite salida |

**INV-04**: un attempt nunca cambia su `providerOperationId`. **INV-10**: una Billing Intent tiene como máximo 5 attempts `AUTO`; un attempt `MANUAL` no cuenta para `INV-10` (D13).

---

## 5.3. Subscription

Estados:

```text
ACTIVE
PAUSED
CANCELLED
```

Transiciones permitidas:

```text
ACTIVE  → PAUSED
ACTIVE  → CANCELLED

PAUSED  → ACTIVE
PAUSED  → CANCELLED
```

No existen transiciones desde `CANCELLED`.

Una operación de `resume` sólo podrá aplicarse a una suscripción `PAUSED`.

---

# 6. Contrato del Payment Adapter

El sistema utilizará:

```text
MockPaymentAdapter
```

El adapter deberá poder simular:

```text
SUCCESS
DECLINED
TIMEOUT
AMBIGUOUS
PROVIDER_ERROR
```

## 6.1. Idempotencia del provider

Cada Payment Attempt genera su propio `providerOperationId`, persistido por write-ahead **antes** de la llamada al adapter (D7): si el proceso muere entre el registro del intento y la respuesta, el attempt queda `IN_FLIGHT` con su id recuperable desde PostgreSQL.

Este identificador deberá permanecer constante durante las operaciones necesarias para verificar el mismo intento.

El MockPaymentAdapter deberá garantizar:

```text
same providerOperationId
→ máximo un cobro efectivo
```

Por tanto:

```text
charge(providerOperationId)
charge(providerOperationId)
```

no podrá producir dos cobros efectivos.

**Contrato de `verify → FAILED` (D7):** una verificación con resultado `FAILED` es **definitiva**: el provider rechaza cualquier `charge` posterior con ese `providerOperationId`. Un `charge` repetido con un id ya verificado como `FAILED` fracasa sin producir cobro.

---

## 6.2. Verificación

El adapter deberá exponer una operación equivalente a:

```text
verify(providerOperationId)
```

que permita consultar:

```text
SUCCEEDED
FAILED
UNKNOWN
```

Cuando un intento quede ambiguo, el sistema deberá utilizar esta operación antes de permitir una nueva ejecución que pueda producir un segundo cobro efectivo.

* `SUCCEEDED` → cierra el cobro (intent `SUCCEEDED`).
* `FAILED` → definitivo (D7) y habilita un nuevo attempt.
* `UNKNOWN` → mantiene el estado y nunca dispara un cobro potencialmente duplicado.

---

# 7. Idempotencia y concurrencia

## RF-01 — Idempotency-Key obligatoria

Toda mutación externa deberá exigir `Idempotency-Key`.

Key ausente, vacía o superior a 255 caracteres:

```http
400 Bad Request
```

---

## RF-02 — Dedupe de operación asentada

Cuando llegue una mutación con una key `SETTLED` dentro de la ventana y payload idéntico:

* devolver la misma respuesta;
* no crear otra Billing Intent;
* no crear otro Payment Attempt;
* no ejecutar otro cobro.

---

## RF-03 — Payload diferente

Cuando llegue una mutación con una key existente dentro de la ventana pero payload canónicamente distinto:

```http
409 Conflict
```

No deberá producir ningún cobro ni modificar la operación original.

---

## RF-04 — Key expirada

Cuando la key haya superado las 24 horas:

* podrá registrarse como nueva operación;
* tendrá un nuevo registro de operación;
* no podrá crear una segunda Billing Intent para el mismo `subscription + billing_cycle`.

---

## RF-05 — Operación en vuelo

Una key registrada pero no asentada deberá responder:

```http
423 Locked
```

No deberá producir ejecución adicional.

---

## RF-06 — Concurrencia same-key

Ante N requests concurrentes con:

```text
same Idempotency-Key
same payload
```

el sistema deberá producir:

```text
1 operación lógica
1 resultado asentado
0 cobros duplicados
```

Las requests concurrentes podrán:

* esperar el resultado;
* o recibir `423` mientras la primera operación permanece en vuelo.

Ambos comportamientos son válidos, pero el sistema deberá mantener consistencia y nunca ejecutar la operación más de una vez.

---

## RF-07 — Concurrencia same-key/different-payload

Ante requests concurrentes:

```text
key = ABC
payload = X

key = ABC
payload = Y
```

exactamente una podrá registrar la operación.

La otra deberá finalizar como:

```http
409 Conflict
```

una vez determinada la existencia de un payload distinto.

No deberá producir ningún cobro adicional.

---

# 8. Suscripciones

## RF-08 — Crear suscripción

El sistema deberá permitir registrar una suscripción:

* diaria;
* semanal;
* mensual;
* anual.

La suscripción tendrá:

```text
startDate
frequency
amount
currency
timezone
status
```

El monto y la divisa serán fijos durante toda la vida de la suscripción.

La fecha de inicio deberá ser válida según el reloj oficial del sistema.

Monto inválido, divisa inválida o fecha no permitida:

```http
400 Bad Request
```

---

## RF-09 — Consulta

El sistema deberá permitir consultar:

* estado de suscripción;
* fecha de próxima facturación;
* historial de Billing Intents;
* Payment Attempts;
* estados finales;
* motivos de fallo.

---

## RF-10 — Cancelación

Una suscripción cancelada:

* no podrá generar nuevas Billing Intents;
* no podrá iniciar nuevos retries automáticos;
* tendrá sus Billing Intents todavía no iniciadas marcadas como `OMITTED` o canceladas según su estado operacional definido;
* no podrá reactivarse mediante reproceso de un pago.

Un Payment Attempt ya `IN_FLIGHT` podrá terminar.

Su resultado deberá conservarse aunque la suscripción pase a `CANCELLED`.

---

# 9. Billing

## D5 — Operación externa de cobro de ciclo

Existe una operación externa:

```text
POST /subscriptions/:id/billing-cycles/:cycle/charge
```

bajo el Guard de idempotencia, que hace get-or-create de la Billing Intent por `(subscription_id, billing_cycle)` y solicita su ejecución. Si la intent ya existe, devuelve su estado actual. Es la operación que ejercita RF-04 y E2E-03 (T21 completa la tabla de endpoints).

---

## RF-11 — Generación de Billing Intent

Cuando una suscripción `ACTIVE` alcance su fecha programada:

```text
Subscription
    ↓
Billing Intent
    ↓
Payment Attempt
```

La Billing Intent deberá identificarse por:

```text
subscription_id + billing_cycle
```

y PostgreSQL deberá impedir duplicados.

---

## RF-12 — Un único cobro lógico

Una Billing Intent podrá contener múltiples attempts, pero nunca más de un cobro efectivo.

Ejemplo válido:

```text
Intent #100

Attempt 1 → timeout
Attempt 2 → declined
Attempt 3 → success
```

Esto representa:

```text
1 Billing Intent
3 Attempts
1 cobro efectivo
```

---

## RF-13 — Exclusividad de ejecución

Mientras un Payment Attempt esté `IN_FLIGHT`:

* no podrá existir otro attempt simultáneo de la misma Billing Intent;
* una segunda ejecución deberá ser rechazada o diferida.

La exclusividad se garantiza mediante PostgreSQL y, opcionalmente, Redis Guard.

---

## RF-14 — No solapamiento de ciclos

Mientras exista una Billing Intent viva para una suscripción:

```text
SCHEDULED
IN_FLIGHT
RETRY_PENDING
UNKNOWN
```

no podrá iniciarse la Billing Intent correspondiente al siguiente ciclo.

Si el momento de procesamiento del ciclo **N+2** llega y el ciclo **N** sigue viva, el ciclo **N+1** se registra `OMITTED(OVERLAP)` (D11); el ciclo siguiente se calcula desde el ancla.

---

# 10. Estados y recuperación

## RF-15 — Resultado confirmado

Un cobro sólo podrá pasar a `SUCCEEDED` cuando exista confirmación verificable del Payment Adapter.

Una respuesta local sin confirmación suficiente no podrá marcar el cobro como exitoso.

---

## RF-16 — Interrupción

Si el worker pierde contacto durante la ejecución:

```text
Billing Intent → UNKNOWN
Payment Attempt → UNKNOWN
```

La interrupción se materializará cuando un proceso de recuperación detecte una ejecución `IN_FLIGHT` cuyo `deadline_at` haya expirado.

Valores por defecto configurables (D8):

```text
ATTEMPT_TIMEOUT       = 60 s   (deadline_at = started_at + timeout)
recovery sweep period = 30 s
```

La información necesaria para recuperarla (incluido el `providerOperationId` write-ahead) deberá estar persistida en PostgreSQL; la recuperación usa exclusivamente datos de PG.

---

## RF-17 — Verificación de UNKNOWN

Antes de iniciar un nuevo cobro sobre una Billing Intent `UNKNOWN`, el sistema deberá consultar el estado del `providerOperationId`.

Resultados:

```text
SUCCEEDED → marcar cobro exitoso
FAILED    → permitir nuevo attempt
UNKNOWN   → mantener UNKNOWN y no ejecutar un cobro potencialmente duplicado
```

Reglas concretas (D7, D9):

* **`verify → FAILED`** es definitivo: habilita un nuevo attempt vía `RETRY_PENDING` si la suscripción está `ACTIVE`; si no está `ACTIVE`, la intent pasa a `OMITTED` con su motivo. Un `charge` posterior con ese id es rechazado por el provider.
* Mientras `verify → UNKNOWN`, la intent **no** vuelve a llamar a `charge`; se programa re-verificación con backoff: `1 min, 2 min, 4 min, …` con tope `1 h` (D9).
* Tras **24 horas** o **10 verificaciones** (lo que ocurra primero), la intent se marca `needs_manual_review = true`: sigue bloqueando el ciclo siguiente (sigue viva) pero queda visible para revisión.

---

## RF-18 — Omitido

Una Billing Intent que no pueda ejecutarse por indisponibilidad del motor, decisión de calendario o de suscripción deberá registrarse como:

```text
OMITTED
```

con su `omitted_reason` obligatorio (D10):

```text
ENGINE_DOWN
SUBSCRIPTION_PAUSED
SUBSCRIPTION_CANCELLED
OVERLAP
```

y no tendrá efectos económicos. Umbral de motor caído (D14): un ciclo cuyo momento de procesamiento pasó hace más de **15 minutos** (configurable) se registra `OMITTED(ENGINE_DOWN)` sin catch-up; dentro de la tolerancia se procesa normalmente.

---

# 11. Reintentos

## RF-19 — Retry automático

Los errores reintentables producirán nuevos Payment Attempts sobre la misma Billing Intent.

Máximo:

```text
5 attempts
```

Configuración:

```text
base delay: 10s
factor: 2
jitter: ±20%
maximum delay: 1h
```

Nota: con 5 attempts hay solo 4 esperas (10 s, 20 s, 40 s, 80 s); el tope de 1 h no se alcanza en el flujo automático y se mantiene como parámetro configurable.

---

## RF-20 — Clasificación de errores

Errores **reintentables directos** (solo cuando el provider declara explícitamente que **no hubo cobro**):

```text
PROVIDER_ERROR
TEMPORARY_UNAVAILABLE
```

Errores **ambiguos** que **no** disparan retry directo y producen attempt `UNKNOWN` (D6):

```text
TIMEOUT
AMBIGUOUS
worker muerto
```

Los ambiguos exigen `verify` antes de cualquier reintento.

Errores no reintentables:

```text
DECLINED
INVALID_PAYMENT
INVALID_AMOUNT
CANCELLED_SUBSCRIPTION
```

La lista podrá ampliarse, pero cada error deberá clasificarse explícitamente.

---

## RF-21 — Retry interno

Un retry automático:

* conserva la Billing Intent;
* crea un nuevo Payment Attempt;
* no crea una nueva Idempotency Operation;
* no pasa por el TTL de idempotencia externa;
* conserva la identidad lógica del cobro.

---

## RF-22 — Agotamiento

Una intent pasa a `FAILED_FINAL` (D12) por cualquiera de estos dos caminos:

1. agotar los 5 attempts automáticos sin éxito verificable;
2. recibir un **error no reintentable** (`DECLINED`, `INVALID_PAYMENT`, `INVALID_AMOUNT`, `CANCELLED_SUBSCRIPTION`) en cualquiera de los attempts.

En ambos casos:

```text
Billing Intent → FAILED_FINAL
Subscription → CANCELLED
```

Además:

```text
CancellationEvent
```

deberá persistirse mediante outbox en la misma transacción.

---

# 12. Calendario

## RF-23 — Fecha programada

La cadencia se calcula desde la fecha de anclaje.

Un ciclo omitido no desplaza los ciclos futuros.

Ejemplo:

```text
Anchor: Jan 10

Jan 10
Feb 10
Mar 10
Apr 10
```

Si Feb 10 es omitido:

```text
Jan 10
Feb 10 → OMITTED
Mar 10
Apr 10
```

---

## RF-24 — Día no hábil

La fecha de calendario se calcula primero.

Después, al procesar:

```text
scheduled date
      ↓
non-business day?
      ↓
next business day
```

El desplazamiento no modifica la fecha de anclaje.

El calendario deberá soportar:

* fines de semana configurables;
* días festivos configurables.

---

## RF-25 — Fin de mes

Mensual:

```text
day 31
```

se conserva cuando existe.

Si no existe:

```text
last day of destination month
```

Luego se aplica el desplazamiento por día no hábil.

Ejemplos:

```text
Jan 31 → Feb 28
Jan 31 → Feb 29
Mar 31 → Apr 30
May 31 → Jun 30
```

Anual:

```text
Feb 29
```

se trunca al último día de febrero en años no bisiestos.

---

# 13. Operaciones administrativas

## RF-26 — Pause

`PAUSE` es una mutación idempotente.

Una suscripción `PAUSED`:

* no genera nuevas Billing Intents;
* no inicia retries pendientes;
* permite finalizar un Payment Attempt ya `IN_FLIGHT`.

---

## RF-27 — Resume

`RESUME` es una mutación idempotente.

Sólo aplica a:

```text
PAUSED → ACTIVE
```

No realiza catch-up.

El siguiente cobro será el siguiente ciclo de calendario posterior a la reanudación.

---

## RF-28 — Cancel

`CANCEL` es una mutación idempotente.

Una suscripción `CANCELLED` no podrá generar nuevos cobros.

Toda cancelación deberá generar:

```text
CancellationEvent
```

persistido mediante outbox.

---

## RF-29 — Reprocess

Podrá reprocesarse una Billing Intent:

```text
UNKNOWN
FAILED_FINAL
```

El reproceso:

* crea un nuevo Payment Attempt **`MANUAL`** (`trigger=MANUAL`, `auto_seq` nulo), que **no** programa retries automáticos (D13);
* mantiene la misma Billing Intent;
* conserva la identidad lógica del cobro;
* no reinicia el backoff automático;
* **no** reactiva una suscripción `CANCELLED`;
* no se ejecuta sobre `SUCCEEDED` (rechazado);
* sobre `UNKNOWN` hace `verify` previo: si `verify → UNKNOWN` se rechaza sin llamar a `charge`; si `verify → SUCCEEDED` cierra el cobro sin ejecutar.

La exclusividad de un attempt `IN_FLIGHT` de la misma intent se respeta (INV-03). `INV-10` solo se aplica a attempts `AUTO` (D13).

---

# 14. Notificaciones / Outbox

Las notificaciones son eventos de dominio persistidos.

Para cancelaciones:

```text
CancellationEvent
```

deberá persistirse en la misma transacción que produce la cancelación.

El transporte externo queda fuera de alcance.

No se implementan:

* email;
* webhooks;
* push;
* SMS.

La outbox deberá poder consultarse mediante API.

---

# 15. Scheduler y motor caído

## RF-30 — Motor disponible

El scheduler deberá identificar ciclos cuyo momento de procesamiento haya llegado y crear Billing Intents de forma idempotente.

---

## RF-31 — Motor caído

Si el motor estuvo indisponible durante una fecha programada más allá de la tolerancia (por defecto **15 minutos**, D14):

```text
Billing Intent → OMITTED(ENGINE_DOWN)
```

No se ejecutará catch-up.

La siguiente fecha se calculará desde el calendario original (sin mover el ancla).

---

# 16. Invariantes de dominio

Estas reglas son obligatorias independientemente del endpoint o worker que ejecute la operación.

### INV-01

Una Billing Intent puede producir como máximo:

```text
1 cobro efectivo
```

---

### INV-02

Una combinación:

```text
subscription_id + billing_cycle
```

puede tener como máximo una Billing Intent.

---

### INV-03

Una Billing Intent puede tener múltiples Payment Attempts, pero como máximo uno `IN_FLIGHT`.

---

### INV-04

Un Payment Attempt nunca puede ejecutarse dos veces con distinto `providerOperationId`.

---

### INV-05

Una Idempotency-Key dentro de su ventana representa como máximo una operación lógica.

---

### INV-06

Una operación `SETTLED` nunca vuelve a `PROCESSING`.

---

### INV-07

Una Billing Intent `SUCCEEDED` nunca vuelve a ejecutar el Payment Adapter.

---

### INV-08

Una suscripción `CANCELLED` nunca genera una nueva Billing Intent.

---

### INV-09

Una suscripción `PAUSED` nunca genera una nueva Billing Intent.

---

### INV-10

Ninguna Billing Intent puede tener más de 5 Payment Attempts automáticos.

---

# 17. Fuera de alcance

* Dashboard operativo.
* React/Tailwind en esta versión del core.
* Integración real con Stripe, PayPal u otros PSP.
* Procesamiento real de tarjetas.
* PCI data.
* Catch-up retroactivo.
* Escalado horizontal como garantía operativa.
* Dunning.
* Comunicaciones al cliente final.
* Refunds.
* Chargebacks.
* Cambio de monto.
* Cambio de divisa.
* Prorrateos.
* Multi-currency conversion.
* Usuarios, roles y autenticación.
* Transporte externo de outbox events.

---

# 18. Criterios de finalización

La implementación estará terminada cuando:

```text
npm run test
npm run test:e2e
npm run lint
```

estén en verde.

Además:

* cobertura ≥ 90 % del núcleo;
* todos los RF tengan trazabilidad a tests;
* todos los invariantes tengan tests;
* los tests de concurrencia utilicen requests concurrentes reales;
* las pruebas críticas utilicen PostgreSQL real o un entorno equivalente de integración;
* las pruebas de BullMQ ejecuten workers reales cuando corresponda.

---

# 19. Escenarios E2E obligatorios

## E2E-01 — Same key concurrente

N requests:

```text
same key
same payload
```

Resultado:

```text
1 operación
1 Billing Intent
1 cobro efectivo máximo
misma respuesta final
```

---

## E2E-02 — Same key / different payload

Requests concurrentes con:

```text
same key
different payload
```

Resultado:

```text
1 operación aceptada
1 request → 409
0 cobros duplicados
```

---

## E2E-03 — Key expirada

Después de 24h:

```text
same key
same payload
```

Resultado:

```text
nueva operación externa
```

pero:

```text
no segunda Billing Intent
```

si el mismo ciclo ya existe.

---

## E2E-04 — Key en vuelo

Mientras una operación está en proceso:

```text
same key
```

Resultado:

```text
423 Locked
```

o espera controlada hasta obtener el resultado.

Nunca un segundo cobro.

---

## E2E-05 — Timeout

Provider:

```text
TIMEOUT
```

Resultado:

```text
Payment Attempt → UNKNOWN
```

y tras `verify → FAILED`, un nuevo Payment Attempt según backoff. Nunca un retry directo sin `verify` (D6).

---

## E2E-06 — Respuesta ambigua

Provider:

```text
charged + response lost
```

Resultado:

```text
Payment Attempt → UNKNOWN
```

Después de reiniciar:

```text
UNKNOWN
    ↓
verify(providerOperationId)
    ↓
SUCCEEDED
```

Nunca un segundo cobro efectivo.

---

## E2E-07 — UNKNOWN todavía no verificable

Provider:

```text
UNKNOWN
```

y verification:

```text
UNKNOWN
```

Resultado:

```text
no nuevo cobro
Billing Intent permanece UNKNOWN
```

---

## E2E-08 — Cinco retries

```text
attempt 1 → retryable failure
attempt 2 → retryable failure
attempt 3 → retryable failure
attempt 4 → retryable failure
attempt 5 → retryable failure
```

Resultado:

```text
FAILED_FINAL
Subscription → CANCELLED
CancellationEvent → persisted
```

---

## E2E-09 — No retry de error definitivo

Provider:

```text
DECLINED
```

Resultado:

```text
no retry automático
```

---

## E2E-10 — Motor caído

Ciclos perdidos:

```text
cycle A
cycle B
```

Resultado:

```text
A → OMITTED
B → OMITTED
next cycle → normal
```

Sin catch-up.

---

## E2E-11 — Pause

Durante:

```text
PAUSED
```

Resultado:

```text
no nuevas Billing Intents
no retries pendientes
attempt IN_FLIGHT puede finalizar
```

---

## E2E-12 — Resume

```text
PAUSED → ACTIVE
```

Resultado:

```text
no catch-up
siguiente ciclo calendario
```

---

## E2E-13 — Cancel durante IN_FLIGHT

```text
Payment Attempt → IN_FLIGHT

Cancel subscription

Provider → SUCCESS
```

Resultado:

```text
Subscription → CANCELLED
Payment → SUCCEEDED
```

No se revierte artificialmente el cobro.

---

## E2E-14 — Reprocess FAILED_FINAL

```text
FAILED_FINAL
Subscription CANCELLED
```

Reprocess:

```text
new Payment Attempt
same Billing Intent
```

Si tiene éxito:

```text
Billing Intent → SUCCEEDED
Subscription remains CANCELLED
```

---

## E2E-15 — Solapamiento de ciclos

Mientras:

```text
cycle N → retry pending
```

llega:

```text
cycle N+1
```

Resultado:

```text
cycle N+1 no inicia
```

hasta que la intención anterior deje de estar viva.

---

## E2E-16 — Fin de mes

Probar:

```text
Jan 31 → Feb 28/29
Mar 31 → Apr 30
May 31 → Jun 30
```

incluyendo desplazamiento a día hábil.

---

# 20. Trazabilidad

Cada RF deberá mapearse a uno o más tests.

Ejemplo:

```text
RF-01 → UNIT-001, E2E-001
RF-02 → E2E-001
RF-03 → E2E-002
RF-04 → E2E-003
RF-05 → E2E-004
RF-15 → E2E-006
RF-17 → E2E-005
RF-19 → E2E-008
RF-24 → E2E-014
RF-25 → E2E-008, E2E-013
RF-27 → E2E-012
```

La matriz completa deberá mantenerse junto al código.

---

# 21. Requisito de migraciones

Las migraciones nuevas deberán:

* ejecutarse sobre una base existente;
* no modificar destructivamente migraciones publicadas;
* mantener compatibilidad con datos existentes;
* ser reproducibles desde cero.

Toda modificación estructural deberá introducirse mediante una nueva migración.

---

# 22. Principio arquitectónico principal

IdemEngine deberá asumir que:

> **cualquier request puede repetirse, cualquier job puede ejecutarse más de una vez y cualquier proceso puede morir en cualquier momento.**

La consistencia no deberá depender de:

* que BullMQ entregue exactamente una vez;
* que Redis mantenga siempre el lock;
* que exista un único worker;
* que una llamada al provider siempre devuelva respuesta.

La garantía deberá emerger de:

```text
Idempotency
+
Domain identity
+
PostgreSQL constraints
+
Transactions
+
Row locking
+
Provider operation identity
+
Explicit state machine
+
Recovery
```

---

# 23. Anexo de endpoints

Anexo de referencia para la API externa (T21). Mapea cada endpoint por método, ruta, tipología, exigencia de `Idempotency-Key` y códigos de respuesta. Las tareas T45 y T50–T55 dependen de esta tabla y de sus códigos de error.

## 23.1. Formato de error normalizado

Toda respuesta de error usa el mismo cuerpo (constitución #6, `NormalizedErrorFilter`):

```json
{
  "error": "SCREAMING_SNAKE_CODE",
  "message": "Mensaje legible para un humano",
  "details": [
    { "path": "amount", "code": "CODE", "message": "..." }
  ]
}
```

`details` es opcional y se usa en errores de validación (`details[].code` por campo). Códigos definidos:

| Código | HTTP | Contexto |
|---|---|---|
| `VALIDATION_ERROR` | 400 | payload o identificador rechazado por Zod |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | mutación sin `Idempotency-Key` (RF-01) |
| `IDEMPOTENCY_KEY_TOO_LONG` | 400 | key de más de 255 caracteres (RF-01) |
| `NOT_FOUND` | 404 | recurso inexistente (suscripción, intent o ciclo) |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | 409 | misma key con payload canónico distinto (RF-03) |
| `INVALID_TRANSITION` | 409 | transición de negocio no permitida (p. ej. resume sobre no `PAUSED`) |
| `REPROCESS_NOT_ELIGIBLE` | 409 | reprocess sobre intent no elegible (`SUCCEEDED`, o `UNKNOWN` no verificable) |
| `IDEMPOTENCY_LOCKED` | 423 | operación en vuelo; incluye header `Retry-After` (D14 y §3.6) |
| `INTERNAL_ERROR` | 500 | error no clasificado |
| `SERVICE_UNAVAILABLE` | 503 | infraestructura no disponible (p. ej. `/health`) |

Reglas de prioridad (D14): el `409` por payload distinto gana sobre el `423`; ante `same key`/`same payload` concurrente se responde `423` sin esperar.

## 23.2. Convenciones

* **Toda mutación es idempotente y exige `Idempotency-Key`** (RF-01). Las consultas (`GET`) no llevan key.
* Los códigos de idempotencia (`400 IDEMPOTENCY_KEY_*`, `409 IDEMPOTENCY_PAYLOAD_MISMATCH`, `423 IDEMPOTENCY_LOCKED`) aplican a todas las mutaciones y no se repiten bajo cada fila.
* `:id` y `:cycle` se validan con Zod; un identificador malformado responde `400 VALIDATION_ERROR`.
* `:cycle` es la **fecha nominal** del ciclo (D4); el desplazamiento a día hábil se aplica al procesar (RF-24/RF-25).

## 23.3. Tabla de endpoints

| Método | Ruta | Tipo | ¿Mutación idempotente? | Éxito | Errores |
|---|---|---|---|---|---|
| `GET` | `/health` | infraestructura | no | `200` | `503 SERVICE_UNAVAILABLE` |
| `GET` | `/` | raíz | no | `200` | — |
| `POST` | `/subscriptions` | mutación (RF-08) | sí | `201` | `400`, `404`¹, `409`, `423`, `500` |
| `GET` | `/subscriptions/:id` | consulta (RF-09) | no | `200` | `400`, `404` |
| `POST` | `/charges` | mutación genérica (T7, ejercicio del Guard) | sí | `201` | `400`, `409`, `423`, `500` |
| `POST` | `/subscriptions/:id/billing-cycles/:cycle/charge` | mutación (RF-04, RF-11, RF-12 · D5) | sí | `200`, `201`, `202` | `400`, `404`, `409`, `423`, `500` |
| `GET` | `/notifications/events` | consulta outbox (§14) | no | `200` | `400`, `500` |
| `POST` | `/subscriptions/:id/pause` | mutación (RF-26) | sí | `200` | `400`, `404`, `409 INVALID_TRANSITION`, `423`, `500` |
| `POST` | `/subscriptions/:id/resume` | mutación (RF-27) | sí | `200` | `400`, `404`, `409 INVALID_TRANSITION`, `423`, `500` |
| `POST` | `/subscriptions/:id/cancel` | mutación (RF-28) | sí | `200` | `400`, `404`, `409`, `423`, `500` |
| `POST` | `/subscriptions/:id/billing-cycles/:cycle/reprocess` | mutación (RF-29) | sí | `200`, `202` | `400`, `404`, `409 REPROCESS_NOT_ELIGIBLE`, `423`, `500` |

¹ Suscripción de origen inexistente en la referencia de la intent; los endpoints que referencian `:id` de suscripción no creada responden `404 NOT_FOUND`.

El historial del `GET /subscriptions/:id` se amplía en T55 con `omitted_reason`, `trigger` por attempt, motivos de fallo y `needs_manual_review` (RF-09).

## 23.4. Detalle por endpoint de las fases 5–7

### `POST /subscriptions/:id/billing-cycles/:cycle/charge` (D5, T45)

Get-or-create de la Billing Intent por `(subscription_id, billing_cycle)` y solicitud de ejecución. Si la intent ya existe, devuelve su estado actual.

* `201 Created` — intent creada y operación asentada (cobro resuelto síncronamente).
* `200 OK` — intent preexistente reutilizada o replay de una operación asentada (misma respuesta).
* `202 Accepted` — ejecución encolada: la operación asienta cuando el attempt deja `IN_FLIGHT` (D2 `SETTLED` por tipo); mientras tanto la misma key responde `423` o `409`.

### `GET /notifications/events` (T44)

Consulta de eventos de dominio (outbox) con filtros opcionales `?type=` y `?aggregateId=`. Sin transporte externo.

* `200 OK` — lista de eventos (posiblemente vacía); siempre `PENDING` en la fase actual, salvo evolución futura con transporte.

### `POST /subscriptions/:id/pause` (T50)

`ACTIVE → PAUSED` (RF-26 · INV-09). `409 INVALID_TRANSITION` si la suscripción es `CANCELLED`. Un attempt `IN_FLIGHT` termina; `UNKNOWN` sigue verificándose.

### `POST /subscriptions/:id/resume` (T51)

`PAUSED → ACTIVE` únicamente (RF-27). `409 INVALID_TRANSITION` si la suscripción **no** está `PAUSED`. Sin catch-up.

### `POST /subscriptions/:id/cancel` (T52)

Cancela la suscripción (RF-28) y persiste `CancellationEvent` en la misma transacción. Un attempt `IN_FLIGHT` conserva su resultado (RF-10). Repetida con la misma key: replay sin duplicar efectos ni eventos.

### `POST /subscriptions/:id/billing-cycles/:cycle/reprocess` (T53, T54)

Reintento manual sobre la intent (RF-29). Crea un attempt `MANUAL` (`auto_seq` nulo) sin retries automáticos y sin reactivar la suscripción.

* `202 Accepted` — reprocess encolado; `200 OK` — intent ya asentada al responder.
* `409 REPROCESS_NOT_ELIGIBLE` — intent `SUCCEEDED`, o `UNKNOWN` cuyo `verify` previo devolvió `UNKNOWN` (no se llama a `charge`).

## 23.5. Cobertura de fases

| Fase | Endpoints nuevos/afectados | Tarea |
|---|---|---|
| Fase 5 — Cobros | `POST .../billing-cycles/:cycle/charge`, `GET /notifications/events` | T45, T44 |
| Fase 6 — Calendario | `GET /subscriptions/:id` (fechas unificadas; sin endpoint nuevo) | T46–T49 |
| Fase 7 — Admin | `POST .../pause`, `POST .../resume`, `POST .../cancel`, `POST .../reprocess` | T50–T54 |
