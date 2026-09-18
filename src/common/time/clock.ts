export interface Clock {
  now(): Date;
}

export const CLOCK = 'CLOCK';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
