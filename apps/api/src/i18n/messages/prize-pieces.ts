import { define } from './define.js';

// Prizes made from a piece of the studio (services/prizes.ts): what the person setting one up is told, what the list says of a piece
// with no approved version, what the public prize page says then, and why a private message waits (kept on the delivery as a code).
export const prizePieces = define({
  es: {
    'prize.piece.unknown': 'Esa pieza no es de esta marca',
    'prize.piece.noApprovedVersion': 'Esa pieza no tiene ninguna versión aprobada: aprueba una antes de usarla como premio',
    'prize.piece.withoutApprovedVersion': 'Sin versión aprobada',
    'prize.piece.unavailablePublic': 'Este premio no está disponible ahora mismo. Vuelve a intentarlo más tarde.',
    'prize.reason.noApprovedVersion': 'La pieza del premio no tiene ninguna versión aprobada: el mensaje sale en cuanto la tenga',
  },
  en: {
    'prize.piece.unknown': 'That piece does not belong to this brand',
    'prize.piece.noApprovedVersion': 'That piece has no approved version: approve one before using it as a prize',
    'prize.piece.withoutApprovedVersion': 'No approved version',
    'prize.piece.unavailablePublic': 'This prize is not available right now. Try again later.',
    'prize.reason.noApprovedVersion': "The prize's piece has no approved version: the message goes out as soon as it has one",
  },
});
