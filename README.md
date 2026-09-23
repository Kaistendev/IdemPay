<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

# IdemEngine

Motor de cobranza recurrente **e idempotente** (Core Fintech). Microservicio
agnóstico con tolerancia a fallos construido sobre NestJS, TypeScript, PostgreSQL
y BullMQ + Redis.

Gestiona suscripciones, reintentos automáticos mediante *exponential backoff*,
prevención de cobros duplicados en escenarios de alta concurrencia y un calendario
de cobro configurable (días no hábiles, fin de mes, motor caído).

## Arquitectura

- **Idempotencia fuerte**: guard por `Idempotency-Key` (ventana 24 h) con locks en
  Redis y asentamiento transaccional en PostgreSQL.
- **Exclusividad de ejecución**: un solo Payment Attempt `IN_FLIGHT` por Billing
  Intent, garantizado por constraints en PostgreSQL (write-ahead + `SELECT ... FOR UPDATE`).
- **Reintentos automáticos**: hasta 5 attempts con backoff `10s · 2^n (±20%)`.
- **Scheduler y calendario**: generación de Billing Intents desde la fecha de
  anclaje, omisión por solapamiento, día no hábil y motor caído.
- **Outbox**: `CancellationEvent` persistido en la misma transacción que la
  cancelación.

## Requerimientos

- Node.js LTS
- PostgreSQL
- Redis
- Docker (opcional, para infraestructura local)

## Project setup

```bash
$ npm install
```

### Infraestructura (Docker)

Levanta PostgreSQL y Redis:

```bash
$ docker compose up -d
```

## Compile and run

```bash
# desarrollo (watch mode)
$ npm run start:dev

# desarrollo (a secas)
$ npm run start

# producción
$ npm run start:prod
```

La API escucha en `http://localhost:3000` (configurable con `process.env.PORT`).

## Tests

```bash
# lint
$ npm run lint

# unit tests
$ npm run test

# e2e tests (concurrencia e idempotencia reales)
$ npm run test:e2e

# cobertura
$ npm run test:cov

# trazabilidad RF/INV/E2E contra la spec
$ npm run test:trace
```

## API

Contrato completo por endpoint en [`docs/api-contract.md`](docs/api-contract.md)
(headers `Idempotency-Key`, bodies, respuestas y códigos de error).

Resumen de endpoints:

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Bienvenida del servicio |
| GET | `/health` | Salud de PostgreSQL y Redis |
| POST | `/subscriptions` | Crear suscripción (requiere `Idempotency-Key`) |
| GET | `/subscriptions/:id` | Detalle de suscripción + historial |
| POST | `/subscriptions/:id/pause` | Pausar suscripción (idempotente) |
| POST | `/subscriptions/:id/resume` | Reanudar suscripción (idempotente) |
| POST | `/subscriptions/:id/cancel` | Cancelar suscripción (idempotente) |
| POST | `/charges` | Cobro único (idempotente) |
| POST | `/subscriptions/:id/billing-cycles/:cycle/charge` | Cobrar ciclo de una suscripción (idempotente) |
| POST | `/subscriptions/:id/billing-cycles/:cycle/reprocess` | Reprocesar Billing Intent `UNKNOWN`/`FAILED_FINAL` |
| GET | `/notifications/events` | Eventos de la outbox (`CancellationEvent`) |

### Idempotencia

Toda mutación (`POST`) exige la cabecera `Idempotency-Key` (1 a 255 caracteres):

- Reintentar con la **misma key** y el **mismo payload** devuelve la respuesta
  original (replay), sin efectos duplicados.
- Reutilizar la key con **payload distinto** → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
- Operación **en vuelo** → `423 IDEMPOTENCY_LOCKED` con `Retry-After`.

Ejemplo:

```bash
# crear una suscripción
curl -X POST http://localhost:3000/subscriptions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid>" \
  -d '{
    "amount": 1500,
    "currency": "USD",
    "frequency": "monthly",
    "startDate": "2026-10-01",
    "timezone": "UTC"
  }'
```

Todos los errores se devuelven normalizados: `{ error, message, details? }`.

## Documentación técnica

- Spec de requisitos (RF, INV, E2E): [`docs/spec.md`](docs/spec.md)
- Plan de implementación: [`docs/plan.md`](docs/plan.md)
- Tareas ejecutables: [`docs/tasks.md`](docs/tasks.md)
- Trazabilidad de requisitos → tests: [`docs/pending.txt`](docs/pending.txt)
- Contrato de API: [`docs/api-contract.md`](docs/api-contract.md)

## License

MIT