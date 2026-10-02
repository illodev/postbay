import { english, isKnown, type Localized } from './i18n/index.js';

/**
 * An error the person asking is told about. `message` is the English text (what logs and older readers see); a message kept as a
 * code (`text`) is answered in the request's language instead.
 */
export class AppError extends Error {
  public text?: Localized;
  constructor(
    public status: number,
    public code: string,
    message: string | Localized,
    public details?: unknown,
  ) {
    super(typeof message === 'string' ? message : english(message));
    if (typeof message !== 'string') this.text = message;
  }
}

type Text = string | Localized;
export const badRequest = (code: string, msg: Text, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg: Text = { code: 'error.unauthorized' }) => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg: Text = { code: 'error.forbidden' }) => new AppError(403, 'forbidden', msg);
/** `what` is the thing in English ("Account"); the ones in the dictionary (error.thing.*) are answered in the request's language. */
export const notFound = (what = 'Resource') => {
  const thing = `error.thing.${what.toLowerCase().replace(/\s+/g, '_')}`;
  return new AppError(404, 'not_found', isKnown(thing) ? { code: 'error.notFound', params: { what: { code: thing } } } : `${what} not found`);
};
export const conflict = (code: string, msg: Text, details?: unknown) => new AppError(409, code, msg, details);
