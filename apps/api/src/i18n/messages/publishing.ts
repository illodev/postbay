import { define } from './define.js';

// What the publisher writes down about an automatic publication: why it is on hold, why it failed, what a person has to do. Kept as
// codes on the publication (hold_reason_i18n, last_error_i18n) and in the attempt history, and put into words when someone reads them.
// `{at}` is the hour the post was due; `{network}` a network's name; `{text}` what a network said, as it said it.
export const publishing = define({
  es: {
    'pub.said': '{text}',

    'pub.hold.approvalLapsed': 'La aprobación de esta publicación ya no vale',
    'pub.hold.filesChanged': 'Los archivos guardados ya no coinciden con los aprobados',
    'pub.hold.newVersion': 'Hay una versión nueva esperando aprobación',
    'pub.hold.dependencyGone': 'La publicación de la que depende está {state}, así que esta no se ha publicado',
    'pub.hold.dependencyLate': 'La publicación de la que depende no había salido a la hora de esta, así que esta no se ha publicado',

    'pub.freeze.paused': 'la marca estaba en pausa',
    'pub.freeze.blocked': 'el {day} estaba bloqueado',
    'pub.freeze.blockedWhy': 'el {day} estaba bloqueado ({reason})',
    'pub.freeze.missed': 'Tenía que salir el {at}, pero {reason}, así que la app no la ha publicado.',
    'pub.freeze.missedEither': 'Tenía que salir el {at}, pero la marca estaba en pausa o el día bloqueado, así que la app no la ha publicado.',
    'pub.freeze.cannotTakeDown': 'Como {reason}, no podía salir nada, pero no se ha podido retirar el post de {network}: bórralo allí a mano. ({error})',

    'pub.cannotPublishTo': 'Este servidor no puede publicar en {network}',
    'pub.notPreparedInTime': 'Tenía que salir el {at} y no se pudo preparar a tiempo, así que no se ha publicado tarde.',
    'pub.notSentLate': 'Tenía que salir el {at} y la app no pudo publicarla en los {minutes} minutos de margen, así que no se ha enviado tarde.',
    'pub.interrupted': 'La publicación había empezado y se cortó antes de dejar nada anotado: mira en {network} por si ha salido.',
    'pub.notFoundNotLate': 'Tenía que salir el {at}. Un intento anterior no terminó y {network} no tiene el post, así que no se ha enviado tarde.',
    'pub.mayAlreadyBeOn': '{message} Puede que ya esté en {network}: compruébalo allí antes de volver a intentarlo.',
    'pub.needsPerson': '{message} Ahora le toca a una persona: publícala a mano o cancélala.',
    'pub.notReconnectedInTime': '{message} La cuenta no se volvió a conectar a tiempo.',
    'pub.limitNotCleared': '{message} El límite no se liberó antes de la hora del post.',
    'pub.failedTimes': '{message} (ha fallado {count} veces seguidas)',
    'pub.couldNotRemove': 'No se ha podido retirar el post de {network}: bórralo allí a mano. ({error})',

    'pub.verify.stillScheduled': 'La red sigue mostrando este post como programado mucho después de su hora.',
    'pub.verify.gone': 'La red ya no muestra este post. Compruébalo allí.',
    'pub.verify.stillProcessing': 'La red sigue procesando este post después de una hora. Compruébalo allí.',

    'pub.firstComment.refused': '{network} no ha aceptado el primer comentario: {error}. Publícalo a mano.',
    'pub.firstComment.fbPermission':
      'Facebook no ha aceptado el primer comentario: comentar como la página necesita el permiso pages_manage_engagement. Vuelve a conectar la página y acéptalo; después publica el comentario a mano. ({error})',

    'pub.manual.unknownAccount': 'Cuenta desconocida',
    'pub.manual.chosen': 'Se ha elegido publicarla a mano',
    'pub.manual.notConnectedHere': 'Esta cuenta se publica a mano: no está conectada a su red',
    'pub.manual.reconnect': 'Hay que volver a conectar esta cuenta para que la app pueda publicar en ella',
    'pub.manual.notConnected': 'Esta cuenta no está conectada a su red',
    'pub.manual.cannotKind': '{network} no deja publicar este tipo de contenido por su API, así que tiene que hacerlo una persona',
  },
  en: {
    'pub.said': '{text}',

    'pub.hold.approvalLapsed': 'The approval behind this publication no longer counts',
    'pub.hold.filesChanged': 'The stored files no longer match the approved ones',
    'pub.hold.newVersion': 'A new version is awaiting approval',
    'pub.hold.dependencyGone': 'The publication it depends on is {state}, so this one was not published',
    'pub.hold.dependencyLate': "The publication it depends on had not gone out by this one's hour, so this one was not published",

    'pub.freeze.paused': 'the brand was paused',
    'pub.freeze.blocked': '{day} is blocked',
    'pub.freeze.blockedWhy': '{day} is blocked ({reason})',
    'pub.freeze.missed': 'It was due {at}, while {reason}, so the app did not publish it.',
    'pub.freeze.missedEither': 'It was due {at}, while the brand was paused or the date blocked, so the app did not publish it.',
    'pub.freeze.cannotTakeDown': 'Nothing may go out because {reason}, but the post could not be taken down from {network}: delete it there by hand. ({error})',

    'pub.cannotPublishTo': 'This server cannot publish to {network}',
    'pub.notPreparedInTime': 'It was due {at} and could not be prepared in time, so it was not published late.',
    'pub.notSentLate': 'It was due {at} and the app was not able to publish it within {minutes} minutes, so it was not sent late.',
    'pub.interrupted': 'Publishing had begun and was interrupted before anything was recorded: check {network} in case it went out.',
    'pub.notFoundNotLate': 'It was due {at}. An earlier try did not finish and {network} does not have the post, so it was not sent late.',
    'pub.mayAlreadyBeOn': '{message} It may already be on {network}: check there before trying again.',
    'pub.needsPerson': '{message} It now needs a person: publish it by hand or cancel it.',
    'pub.notReconnectedInTime': '{message} The account was not reconnected in time.',
    'pub.limitNotCleared': '{message} The limit did not clear before the post was due.',
    'pub.failedTimes': '{message} (failed {count} times in a row)',
    'pub.couldNotRemove': 'Could not remove the post from {network}: delete it there by hand. ({error})',

    'pub.verify.stillScheduled': 'The network still shows this post as scheduled, long after its hour.',
    'pub.verify.gone': 'The network no longer shows this post. Check it there.',
    'pub.verify.stillProcessing': 'The network is still processing this post after an hour. Check it there.',

    'pub.firstComment.refused': '{network} refused the first comment: {error}. Post it by hand.',
    'pub.firstComment.fbPermission':
      'Facebook refused the first comment: commenting as the Page needs the pages_manage_engagement permission. Connect the Page again and accept it, then post the comment by hand. ({error})',

    'pub.manual.unknownAccount': 'Unknown account',
    'pub.manual.chosen': 'Chosen to be published by hand',
    'pub.manual.notConnectedHere': 'This account is published by hand: it is not connected to its network',
    'pub.manual.reconnect': 'This account has to be reconnected before the app can publish to it',
    'pub.manual.notConnected': 'This account is not connected to its network',
    'pub.manual.cannotKind': '{network} cannot publish this kind of content through its API, so a person has to',
  },
});
