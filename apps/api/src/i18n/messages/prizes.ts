import { define } from './define.js';

// Prizes: why a setting cannot be saved, what the public prize page says, and why a prize could not be sent to someone (kept on the
// delivery as a code, `prize_delivery.reason_i18n`, next to the English reason). `{network}` is the network's id, `{error}` and `{text}`
// what the network said, as it said it.
export const prizes = define({
  es: {
    'prize.notAFile': 'Solo se sube un premio de tipo archivo',
    'prize.notUploaded': 'El archivo todavía no ha llegado',
    'prize.fileMismatch': 'Lo guardado no es el archivo que se declaró. Vuelve a subirlo.',
    'prize.publicationClosed': 'Una publicación cancelada o fallida no puede llevar premio',
    'prize.unknown': 'Ese premio no es de esta marca',
    'prize.archived': 'Ese premio está archivado',
    'prize.notReady': 'Ese premio todavía no tiene archivo',
    'prize.invalidKeyword': 'La palabra clave necesita al menos una letra o un número',
    'prize.linkMissing': 'El mensaje tiene que llevar {{link}}, que es donde va el enlace al premio',
    'prize.off': 'Los premios están desactivados en esta marca. Un administrador puede activarlos en Ajustes.',
    'prize.noticeRequired': 'Confirma que el texto del post avisa de que la respuesta es automática y de qué se hace con los datos. Sin eso, el premio no se pone en marcha.',
    'prize.needsReconnect': 'Hay que volver a conectar esta cuenta para que pueda enviar mensajes',
    'prize.noMessagingPermission': 'Esta cuenta se conectó sin permiso para enviar mensajes. Vuelve a conectarla con los premios activados para concedérselo.',

    'prize.link.expired': 'Este enlace ha caducado.',
    'prize.link.usedUp': 'Este enlace ya se ha usado todas las veces que permite.',
    'prize.page.expired': 'Esta página ha caducado.',

    'prize.reason.said': '{text}',
    'prize.reason.reconnect': 'Hay que volver a conectar la cuenta para que pueda enviar mensajes',
    'prize.reason.hourlyLimit': 'Se ha llegado al límite de mensajes privados por hora de esta cuenta',
    'prize.reason.cannotMessage': 'La app no puede enviar mensajes privados en {network} desde aquí',
    'prize.reason.networkLimit': '{error} (el límite de la red)',
    'prize.reason.notAllowed': 'La conexión no tiene permiso para enviar mensajes: {error}',
    'prize.reason.windowEnded': '{reason} (y se acabaron los 7 días que da Meta para responder)',
  },
  en: {
    'prize.notAFile': 'Only a file prize is uploaded',
    'prize.notUploaded': 'The file has not arrived yet',
    'prize.fileMismatch': 'What was stored is not the file that was declared. Upload it again.',
    'prize.publicationClosed': 'A cancelled or failed publication cannot carry a prize',
    'prize.unknown': 'That prize does not belong to this brand',
    'prize.archived': 'That prize has been archived',
    'prize.notReady': 'That prize has no file yet',
    'prize.invalidKeyword': 'The keyword needs at least one letter or digit',
    'prize.linkMissing': 'The message has to contain {{link}}, where the link to the prize goes',
    'prize.off': 'Prizes are switched off for this brand. An admin can switch them on in Settings.',
    'prize.noticeRequired': "Confirm that the post's own text tells people the reply is automatic and what is done with their data. A prize does not run without it.",
    'prize.needsReconnect': 'This account has to be connected again before it can send messages',
    'prize.noMessagingPermission': 'This account was connected without the permission to send messages. Connect it again, with prizes switched on, to grant it.',

    'prize.link.expired': 'This link has expired.',
    'prize.link.usedUp': 'This link has been used the most times it allows.',
    'prize.page.expired': 'This page has expired.',

    'prize.reason.said': '{text}',
    'prize.reason.reconnect': 'The account has to be connected again before it can send messages',
    'prize.reason.hourlyLimit': 'The hourly limit of private messages for this account was reached',
    'prize.reason.cannotMessage': 'The app cannot send private messages on {network} here',
    'prize.reason.networkLimit': "{error} (the network's limit)",
    'prize.reason.notAllowed': 'The connection is not allowed to send messages: {error}',
    'prize.reason.windowEnded': '{reason} (and the 7 days Meta allows for a reply ran out)',
  },
});
