import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { CommonModule } from '../src/common/common.module';
import { ZodValidationPipe } from '../src/common/validation/zod-validation.pipe';

const CreateSubscriptionSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
});

@Controller('common-test')
class CommonTestController {
  @Post()
  echo(
    @Body(new ZodValidationPipe(CreateSubscriptionSchema))
    body: {
      amount: number;
      currency: string;
    },
  ): { received: { amount: number; currency: string } } {
    return { received: body };
  }
}

describe('CommonModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CommonModule],
      controllers: [CommonTestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a valid request and returns the parsed DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/common-test')
      .send({ amount: 1500, currency: 'ARS' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      received: { amount: 1500, currency: 'ARS' },
    });
  });

  it('rejects an invalid request with 400 and a normalized body', async () => {
    const response = await request(app.getHttpServer())
      .post('/common-test')
      .send({ amount: -5, currency: 'US' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request payload',
    });
    expect(response.text).toContain('"path":"amount"');
    expect(response.text).toContain('"path":"currency"');
  });

  it('normalizes unknown routes through the global error filter', async () => {
    const response = await request(app.getHttpServer()).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'NOT_FOUND' });
  });
});
