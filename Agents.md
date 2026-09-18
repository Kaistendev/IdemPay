# AGENTS.md — IdemEngine

## Proyecto

IdemEngine es un motor de cobranza recurrente e idempotente (Core Fintech) diseñado como un microservicio agnóstico con tolerancia a fallos. Utiliza NestJS, TypeScript, PostgreSQL y BullMQ + Redis para gestionar suscripciones, reintentos automáticos mediante *exponential backoff* y prevención de cobros duplicados en escenarios de alta concurrencia. Incluye un dashboard operativo en React + Tailwind CSS para monitoreo de métricas y ejecuciones en segundo plano.

## Comandos

* Ejecutar: `docker compose up -d` (Infraestructura completa) | `npm run start:dev` (API NestJS)
* Tests: `npm run test` (Unitarios) | `npm run test:e2e` (Pruebas de concurrencia e idempotencia)
* Lint/formato: `npm run lint` | `npx prettier --write .`

## Estilo y convenciones

* **Entorno y Lenguaje:** TypeScript 5.x sobre Node.js LTS.
* **Estructura NestJS:** Arquitectura modular por capas (Controllers, Services, Modules, DTOs).
* **Convención de nombres:** `camelCase` para variables/funciones, `PascalCase` para clases, interfaces y módulos; `kebab-case.suffix.ts` para nombres de archivos (ej. `charge-executor.service.ts`).
* **Idioma del proyecto:** Código, tipos, interfaces, logs y mensajes de commit estrictamente en **Inglés**. Documentación conceptual en **Español**.
* **Manejo de Errores y Validaciones:** Validación de payloads con Zod e inyección de dependencias para contratos e interfaces (`IPaymentGateway`).

## Reglas

* Lee docs/constitution.md y la spec activa antes de tocar código.
* **Cero dependencias reales de pasarelas:** No instales ni utilices SDKs externos de Stripe o PayPal; toda integración debe implementarse usando el patrón adaptador con `IPaymentGateway` y `MockPaymentAdapter`.
* **Intactitud del Core:** No alteres el Guard de idempotencia en Redis ni los bloqueos pesimistas de PostgreSQL (`SELECT ... FOR UPDATE`) sin autorización explícita.
* **Gestión de Base de Datos:** Nunca modifiques migraciones pasadas de PostgreSQL. Crea siempre un nuevo archivo de migración.

## Al terminar cualquier tarea

* Ejecuta la suite de pruebas completa (`npm run test` y `npm run test:e2e`) para verificar que los escenarios de carrera e idempotencia no hayan sufrido regresiones.
* Ejecuta `npm run lint` y asegura que el código cumpla con las convenciones de formateo antes de realizar un commit.