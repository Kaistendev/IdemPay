# Spec — IdemEngine (v1.1)

> Rev v1.1 — Cierra ambigüedades de v1.1: formaliza la separación entre Idempotency Operation, Billing Intent y Payment Attempt; define el contrato del MockPaymentAdapter y la recuperación de estados ambiguos; establece PostgreSQL como fuente de verdad; formaliza transiciones de suscripción, pausa, cancelación y reproceso; define concurrencia de idempotency keys; precisa calendario, tiempo y materialización de ciclos omitidos; añade invariantes de dominio y criterios de aceptación verificables.

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

Una suscripción no podrá tener más de una Billing Intent para el mismo ciclo.

La expiración de una Idempotency-Key nunca permitirá crear una segunda Billing Intent para un ciclo que ya tenga una intención viva o asentada.

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

La ventana es un TTL fijo de:

```text
24 horas
```

El TTL comienza en el primer registro durable de la key.

No existe período de gracia.

Una vez expirado el TTL, la key podrá representar una nueva operación.

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

Una operación externa puede estar:

```text
PROCESSING
SETTLED
```

Una operación está `SETTLED` únicamente cuando:

1. la Billing Intent correspondiente alcanzó un resultado terminal verificable;
2. dicho resultado fue persistido;
3. la transacción PostgreSQL correspondiente realizó commit.

Un resultado local no confirmado no se considera `SETTLED`.

---

## 3.5. Respuesta de dedupe

Cuando una key `SETTLED` recibe nuevamente el mismo payload dentro de la ventana:

* no se crea una nueva Billing Intent;
* no se crea un nuevo Payment Attempt;
* no se ejecuta el Payment Adapter;
* se devuelve exactamente la respuesta HTTP previamente asentada.

---

## 3.6. Operación en vuelo

Si la key existe, está dentro de la ventana y la operación todavía no está `SETTLED`:

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

No deberá iniciar otra ejecución.

---

# 4. Fuente de verdad y coordinación

PostgreSQL es la **fuente de verdad del estado de negocio**.

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

El Redis Guard es un mecanismo complementario de coordinación y no sustituye las garantías de PostgreSQL.

---

# 5. Estados

## 5.1. Billing Intent

Estados:

```text
SCHEDULED
    ↓
IN_FLIGHT
    ├── SUCCEEDED
    ├── FAILED_FINAL
    ├── UNKNOWN
    └── OMITTED
```

`FAILED_FINAL` significa que el intento automático agotó sus retries.

`UNKNOWN` significa que no existe confirmación verificable del resultado económico.

Una Billing Intent `SUCCEEDED` nunca podrá volver a un estado no terminal.

---

## 5.2. Payment Attempt

Estados:

```text
IN_FLIGHT
    ├── SUCCEEDED
    ├── FAILED
    └── UNKNOWN
```

`UNKNOWN` significa que la ejecución no produjo una confirmación verificable.

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

Cada Payment Attempt deberá utilizar un identificador estable de operación hacia el provider:

```text
providerOperationId
```

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
UNKNOWN
retry pending
```

no podrá iniciarse la Billing Intent correspondiente al siguiente ciclo.

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

La interrupción se materializará cuando un proceso de recuperación detecte una ejecución `IN_FLIGHT` cuyo timeout haya expirado.

La información necesaria para recuperarla deberá estar persistida en PostgreSQL.

---

## RF-17 — Verificación de UNKNOWN

Antes de iniciar un nuevo cobro sobre una Billing Intent `UNKNOWN`, el sistema deberá consultar el estado del `providerOperationId`.

Resultados:

```text
SUCCEEDED → marcar cobro exitoso
FAILED    → permitir nuevo attempt
UNKNOWN   → mantener UNKNOWN y no ejecutar un cobro potencialmente duplicado
```

---

## RF-18 — Omitido

Una Billing Intent que no pueda ejecutarse por indisponibilidad del motor o decisión de calendario deberá registrarse como:

```text
OMITTED
```

y no tendrá efectos económicos.

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

---

## RF-20 — Clasificación de errores

Errores reintentables:

```text
TIMEOUT
PROVIDER_ERROR
TEMPORARY_UNAVAILABLE
```

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

Al alcanzar 5 attempts sin éxito verificable:

```text
Billing Intent → FAILED_FINAL
Subscription → CANCELLED
```

Además:

```text
CancellationEvent
```

deberá persistirse mediante outbox.

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

* crea un nuevo Payment Attempt;
* mantiene la misma Billing Intent;
* conserva la identidad lógica del cobro;
* no reinicia el backoff automático;
* no se ejecuta sobre `SUCCEEDED`.

Un reproceso exitoso **no reactiva automáticamente una suscripción `CANCELLED`**.

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

Si el motor estuvo indisponible durante una fecha programada:

```text
Billing Intent → OMITTED
```

No se ejecutará catch-up.

La siguiente fecha se calculará desde el calendario original.

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
nuevo Payment Attempt
```

según backoff.

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
