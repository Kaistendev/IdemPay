# Constitution — IdemEngine

1. Stack fijo: NestJS + TypeScript 5 + PostgreSQL + Redis/BullMQ. Cambios solo tras RFC aprobada.
2. Código, tipos, interfaces, logs y commits en inglés; docs conceptuales en español.
3. Idempotencia es ley: toda mutación exige idempotency-key; nunca romper el Guard de Redis ni los bloqueos `FOR UPDATE`.
4. Cero SDKs reales de pasarelas: toda integración vía `IPaymentGateway` + `MockPaymentAdapter`.
5. Validación obligatoria de payloads con Zod en el borde de entrada.
6. DTOs e interfaces explícitas; prohíbo `any`, `@ts-ignore` y casteos silenciosos.
7. Reintentos solo con exponential backoff + jitter; nunca cobros duplicados por reintento.
8. Cada módulo expone tests unitarios; las carreras e idempotencia viven en `test:e2e`.
9. Regla de oro: `npm run test`, `test:e2e` y `lint` pasan antes de commit. Sin excepciones.
10. Migraciones inmutables: nunca editar una ya aplicada; siempre migración nueva.
11. No introducir dependencias sin justificación escrita; cada dependencia nueva exige revisión.
12. Cobertura mínima del core (guardias, executor, scheduler) ≥ 90%.
13. Toda regla nueva se añade verificándola en CI para que sea obligatoria, no opcional.