import { BadRequestException, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';

interface ZodLike<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };
}

/** `@commander/contracts` Zod sxemalari bilan body/query validatsiyasi (kiritilgan qiymat javobga qaytarilmaydi). */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodLike<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
