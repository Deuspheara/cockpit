export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details: unknown = {},
  ) {
    super(message);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}
export class NotFoundError extends AppError {
  constructor(message = "Record not found") {
    super("NOT_FOUND", message, 404);
  }
}
