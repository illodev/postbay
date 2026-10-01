export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Sign in required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do this') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
