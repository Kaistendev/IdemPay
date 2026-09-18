import type { ErrorDetail } from './normalized-error';

export interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

export function mapZodIssues(issues: readonly ZodIssueLike[]): ErrorDetail[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}
