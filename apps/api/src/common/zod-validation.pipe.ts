import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** Thrown when a request body/query fails contract validation. */
export class ZodValidationException extends Error {
  constructor(public readonly issues: Array<{ path: string; message: string }>) {
    super('Request validation failed');
    this.name = 'ZodValidationException';
  }
}

/**
 * Request validation against @spectra/contracts Zod schemas.
 * Usage: `@Body(new ZodValidationPipe(schema)) body: z.infer<typeof schema>`
 */
@Injectable()
export class ZodValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.infer<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ZodValidationException(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
