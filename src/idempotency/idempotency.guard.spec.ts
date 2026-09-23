import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { IdempotencyGuard } from './idempotency.guard';
import type { IdempotencyRequest } from './idempotency.context';
import type { IdempotencyKeyLock } from './idempotency.lock';
import type { IdempotencyRepository } from './idempotency.repository';
import type {
  IdempotencyRegistration,
  IdempotencySettlement,
} from './idempotency.types';

interface FakeRow {
  key: string;
  payloadHash: string;
  generation: number;
  status: 'PROCESSING' | 'SETTLED';
  response: { statusCode: number; body: unknown } | null;
  billingIntentId: string | null;
}

class FakeRepository {
  private readonly rows = new Map<string, FakeRow>();
  private readonly operationTypes = new Map<string, string>();

  registerOrGet(
    key: string,
    payloadHash: string,
    operationType = 'SUBSCRIPTION_CREATE',
  ): Promise<IdempotencyRegistration> {
    this.operationTypes.set(key, operationType);
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, {
        key,
        payloadHash,
        generation: 1,
        status: 'PROCESSING',
        response: null,
        billingIntentId: null,
      });
      return Promise.resolve({ outcome: 'NEW', generation: 1 });
    }
    if (existing.payloadHash !== payloadHash) {
      return Promise.resolve({
        outcome: 'MISMATCH',
        storedPayloadHash: existing.payloadHash,
      });
    }
    if (existing.status === 'SETTLED') {
      return Promise.resolve({
        outcome: 'REPLAY',
        response: existing.response ?? { statusCode: 0, body: null },
        billingIntentId: existing.billingIntentId,
      });
    }
    return Promise.resolve({
      outcome: 'IN_FLIGHT',
      leaseRemainingSeconds: 300,
    });
  }

  settle(key: string, settlement: IdempotencySettlement): Promise<boolean> {
    const existing = this.rows.get(key);
    if (!existing || existing.status !== 'PROCESSING') {
      return Promise.resolve(false);
    }
    this.rows.set(key, {
      ...existing,
      status: 'SETTLED',
      response: settlement.response,
      billingIntentId: settlement.billingIntentRef,
    });
    return Promise.resolve(true);
  }

  read(key: string): Promise<FakeRow | null> {
    return Promise.resolve(this.rows.get(key) ?? null);
  }

  operationTypeFor(key: string): string | undefined {
    return this.operationTypes.get(key);
  }
}

function buildRequest(
  headers: Record<string, unknown>,
  body: unknown,
  method = '',
  path = '',
): IdempotencyRequest {
  return { headers, body, method, path } as unknown as IdempotencyRequest;
}

function buildContext(
  request: IdempotencyRequest,
  response: { setHeader: (name: string, value: string) => void } = {
    setHeader: () => undefined,
  },
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

async function captureHttpError(
  promise: Promise<unknown>,
): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the guard to reject the request');
}

describe('IdempotencyGuard', () => {
  const key = 'operation-1';
  const body = { amount: 100, currency: 'USD' };
  let repository: FakeRepository;
  let guard: IdempotencyGuard;

  beforeEach(() => {
    repository = new FakeRepository();
    guard = new IdempotencyGuard(
      repository as unknown as IdempotencyRepository,
      {
        acquire: () => Promise.resolve(true),
      } as unknown as IdempotencyKeyLock,
    );
  });

  it('accepts a keyed request and registers it as PROCESSING // T61: @INV-05', async () => {
    const request = buildRequest({ 'idempotency-key': key }, body);

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(request.idempotencyOperationContext).toMatchObject({
      key,
      acquired: true,
      generation: 1,
      replay: null,
    });
    const record = await repository.read(key);
    expect(record?.status).toBe('PROCESSING');
  });

  it('rejects a missing key with 400', async () => {
    const error = await captureHttpError(
      guard.canActivate(buildContext(buildRequest({}, body))),
    );

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({
      error: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  });

  it('rejects a blank key with 400', async () => {
    const error = await captureHttpError(
      guard.canActivate(
        buildContext(buildRequest({ 'idempotency-key': '   ' }, body)),
      ),
    );

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({
      error: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  });

  it('rejects a key longer than 255 characters with 400', async () => {
    const error = await captureHttpError(
      guard.canActivate(
        buildContext(
          buildRequest({ 'idempotency-key': 'k'.repeat(256) }, body),
        ),
      ),
    );

    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.getResponse()).toMatchObject({
      error: 'IDEMPOTENCY_KEY_TOO_LONG',
    });
  });

  it('rejects a different payload for an existing key with 409', async () => {
    await guard.canActivate(
      buildContext(buildRequest({ 'idempotency-key': key }, body)),
    );

    const error = await captureHttpError(
      guard.canActivate(
        buildContext(
          buildRequest(
            { 'idempotency-key': key },
            { amount: 200, currency: 'USD' },
          ),
        ),
      ),
    );

    expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(error.getResponse()).toMatchObject({
      error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });
  });

  it('rejects an in-flight key with 423 and Retry-After', async () => {
    await guard.canActivate(
      buildContext(buildRequest({ 'idempotency-key': key }, body)),
    );

    const headers = new Map<string, string>();
    const response = {
      setHeader(name: string, value: string): void {
        headers.set(name, value);
      },
    };
    const error = await captureHttpError(
      guard.canActivate(
        buildContext(buildRequest({ 'idempotency-key': key }, body), response),
      ),
    );

    expect(error.getStatus()).toBe(HttpStatus.LOCKED);
    expect(error.getResponse()).toMatchObject({
      error: 'IDEMPOTENCY_LOCKED',
      status: 'PROCESSING',
    });
    expect(headers.get('Retry-After')).toBe('300');
  });

  it('exposes the settled response for a duplicate payload // T61: @INV-06', async () => {
    await guard.canActivate(
      buildContext(buildRequest({ 'idempotency-key': key }, body)),
    );
    await repository.settle(key, {
      response: { statusCode: 201, body: { id: 'bi-1' } },
      billingIntentRef: 'bi-1',
    });

    const replay = buildRequest({ 'idempotency-key': key }, body);

    await expect(guard.canActivate(buildContext(replay))).resolves.toBe(true);

    expect(replay.idempotencyOperationContext).toMatchObject({
      acquired: false,
      generation: null,
      billingIntentRef: 'bi-1',
      replay: { statusCode: 201, body: { id: 'bi-1' } },
    });
  });

  it('treats canonically equivalent payloads as the same operation', async () => {
    await guard.canActivate(
      buildContext(
        buildRequest(
          { 'idempotency-key': key },
          { amount: 100, currency: 'USD' },
        ),
      ),
    );
    await repository.settle(key, {
      response: { statusCode: 201, body: { id: 'bi-1' } },
      billingIntentRef: 'bi-1',
    });

    const replay = buildRequest(
      { 'idempotency-key': key },
      { currency: ' USD ', amount: '100' },
    );

    await expect(guard.canActivate(buildContext(replay))).resolves.toBe(true);

    expect(replay.idempotencyOperationContext?.replay).toEqual({
      statusCode: 201,
      body: { id: 'bi-1' },
    });
  });

  it('maps the pause route to SUBSCRIPTION_PAUSE', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'POST',
      '/subscriptions/sub-1/pause',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('SUBSCRIPTION_PAUSE');
  });

  it('maps the resume route to SUBSCRIPTION_RESUME', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'POST',
      '/subscriptions/sub-1/resume',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('SUBSCRIPTION_RESUME');
  });

  it('maps the cancel route to SUBSCRIPTION_CANCEL', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'POST',
      '/subscriptions/sub-1/cancel',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('SUBSCRIPTION_CANCEL');
  });

  it('maps the subscription reprocess route to BILLING_INTENT_REPROCESS', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'POST',
      '/subscriptions/sub-1/reprocess',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('BILLING_INTENT_REPROCESS');
  });

  it('maps the one-off charges route to BILLING_CYCLE_CHARGE', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'POST',
      '/charges',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('BILLING_CYCLE_CHARGE');
  });

  it('falls back to SUBSCRIPTION_CREATE for non-POST requests', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'GET',
      '/subscriptions',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('SUBSCRIPTION_CREATE');
  });

  it('maps the billing cycle charge route to BILLING_CYCLE_CHARGE', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'POST',
      '/subscriptions/sub-1/billing-cycles/2026-09-10/charge',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('BILLING_CYCLE_CHARGE');
  });

  it('maps the billing cycle reprocess route to BILLING_INTENT_REPROCESS', async () => {
    const request = buildRequest(
      { 'idempotency-key': key },
      {},
      'POST',
      '/subscriptions/sub-1/billing-cycles/2026-09-10/reprocess',
    );

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(repository.operationTypeFor(key)).toBe('BILLING_INTENT_REPROCESS');
  });

  it('compares keys exactly', async () => {
    await guard.canActivate(
      buildContext(buildRequest({ 'idempotency-key': 'key-a' }, body)),
    );

    await expect(
      guard.canActivate(
        buildContext(buildRequest({ 'idempotency-key': 'key-a ' }, body)),
      ),
    ).resolves.toBe(true);

    expect(await repository.read('key-a ')).not.toBeNull();
  });
});
