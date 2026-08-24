export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export interface Schema<T> {
  parse(input: unknown): T;
}

export function expectRecord(input: unknown, name: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SchemaValidationError(`${name} must be an object`);
  }

  return input as Record<string, unknown>;
}

export function expectNonEmptyString(input: unknown, name: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new SchemaValidationError(`${name} must be a non-empty string`);
  }

  return input;
}

export function expectPositiveInteger(input: unknown, name: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    throw new SchemaValidationError(`${name} must be a positive integer`);
  }

  return input as number;
}

export function expectPositiveFiniteNumber(input: unknown, name: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    throw new SchemaValidationError(`${name} must be a positive finite number`);
  }

  return input;
}

export function expectNonNegativeInteger(input: unknown, name: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new SchemaValidationError(`${name} must be a non-negative integer`);
  }

  return input as number;
}
