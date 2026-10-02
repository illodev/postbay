import { define } from './define';

// API error codes the person can act on. Anything not here shows the server's own message.
export const errors = define({
  es: {
    'errors.network': 'No se ha podido contactar con el servidor. Comprueba la conexión.',
    'errors.unauthorized': 'Tu sesión ha caducado. Vuelve a entrar.',
    'errors.forbidden': 'No tienes permiso para hacer esto.',
    'errors.not_found': 'No existe o ya no está disponible.',
    'errors.rate_limited': 'Demasiados intentos. Espera un momento.',
    'errors.second_factor_required': 'Hace falta el segundo paso de inicio de sesión.',
    'errors.piece_discarded': 'La pieza está descartada.',
    'errors.variant_exists': 'Ya hay una variante con ese formato y estilo.',
  },
  en: {
    'errors.network': 'Could not reach the server. Check your connection.',
    'errors.unauthorized': 'Your session has expired. Sign in again.',
    'errors.forbidden': 'You are not allowed to do this.',
    'errors.not_found': 'It does not exist or is no longer available.',
    'errors.rate_limited': 'Too many attempts. Wait a moment.',
    'errors.second_factor_required': 'The second sign-in step is needed.',
    'errors.piece_discarded': 'The piece is discarded.',
    'errors.variant_exists': 'A variant with that format and style already exists.',
  },
});
