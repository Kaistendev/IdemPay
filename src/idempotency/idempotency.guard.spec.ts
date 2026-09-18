import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { IdempotencyGuard } from './idempotency.guard';
import type { IdempotencyRequest } from './idempotency.context';
import type {
  BeginIdempotencyResult,
  IdempotencyRecord,
  IdempotencySettlement,
  IdempotencyStorePort,
} from './idempotency.types';

const CREATED_AT = '2026-09-17T00:00:00.000Z';

class FakeIdempotencyStore implements IdempotencyStorePort {
  private readonly records = new Map<string, IdempotencyRecord>();

  begin(key: string, payloadHash: string): Promise<BeginIdempotencyResult> {
    const existing = this.records.get(key);
    if (existing) {
      return Promise.resolve({ acquired: false, record: existing });
    }
    const record: IdempotencyRecord = {
      key,
      payloadHash,
      state: 'PROCESSING',
      response: null,
      billingIntentRef: null,
      createdAt: CREATED_AT,
      settledAt: null,
    };
    this.records.set(key, record);
    return Promise.resolve({ acquired: true, record });
  }

  settle(
    key: string,
    settlement: IdempotencySettlement,
  ): Promise<IdempotencyRecord | null> {
    const existing = this.records.get(key);
    if (!existing || existing.state !== 'PROCESSING') {
      return Promise.resolve(null);
    }
    const updated: IdempotencyRecord = {
      ...existing,
      state: 'SETTLED',
      response: settlement.response,
      billingIntentRef: settlement.billingIntentRef,
      settledAt: CREATED_AT,
    };
    this.records.set(key, updated);
    return Promise.resolve(updated);
  }

  read(key: string): Promise<IdempotencyRecord | null> {
    return Promise.resolve(this.records.get(key) ?? null);
  }

  ttlMillis(): Promise<number> {
    return Promise.resolve(86_400_000);
  }
}

function buildRequest(
  headers: Record<string, unknown>,
  body: unknown,
): IdempotencyRequest {
  return { headers, body } as unknown as IdempotencyRequest;
}

function buildContext(request: IdempotencyRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
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
  let store: FakeIdempotencyStore;
  let guard: IdempotencyGuard;

  beforeEach(() => {
    store = new FakeIdempotencyStore();
    guard = new IdempotencyGuard(store);
  });

  it('accepts a keyed request and registers it as PROCESSING', async () => {
    const request = buildRequest({ 'idempotency-key': key }, body);

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);

    expect(request.idempotencyOperationContext).toMatchObject({
      key,
      acquired: true,
      replay: null,
    });
    const record = await store.read(key);
    expect(record?.state).toBe('PROCESSING');
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

  it('rejects an in-flight key with 423', async () => {
    await guard.canActivate(
      buildContext(buildRequest({ 'idempotency-key': key }, body)),
    );

    const error = await captureHttpError(
      guard.canActivate(
        buildContext(buildRequest({ 'idempotency-key': key }, body)),
      ),
    );

    expect(error.getStatus()).toBe(HttpStatus.LOCKED);
    expect(error.getResponse()).toMatchObject({
      error: 'IDEMPOTENCY_LOCKED',
      status: 'PROCESSING',
    });
  });

  it('exposes the settled response for a duplicate payload', async () => {
    await guard.canActivate(
      buildContext(buildRequest({ 'idempotency-key': key }, body)),
    );
    await store.settle(key, {
      response: { statusCode: 201, body: { id: 'bi-1' } },
      billingIntentRef: 'bi-1',
    });

    const replay = buildRequest({ 'idempotency-key': key }, body);

    await expect(guard.canActivate(buildContext(replay))).resolves.toBe(true);

    expect(replay.idempotencyOperationContext).toMatchObject({
      acquired: false,
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
    await store.settle(key, {
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

  it('compares keys exactly', async () => {
    await guard.canActivate(
      buildContext(buildRequest({ 'idempotency-key': 'key-a' }, body)),
    );

    await expect(
      guard.canActivate(
        buildContext(buildRequest({ 'idempotency-key': 'key-a ' }, body)),
      ),
    ).resolves.toBe(true);

    expect(await store.read('key-a ')).not.toBeNull();
  });
});
