import { define } from './define';

// What came after the phases: deactivating members, scheduling after approval (a piece made for a slot, free slots, the agent),
// prizes from a piece, and the brand's variant styles. Spanish first; English must have the same keys (TypeScript checks it).
export const features = define({
  es: {
    // Members: deactivating and reactivating.
    'members.deactivate': 'Desactivar',
    'members.reactivate': 'Reactivar',
    'members.deactivateTitle': '¿Desactivar a {name}?',
    'members.deactivateText': 'No podrá abrir esta marca ni recibirá avisos de ella hasta que la reactives. Lo que hizo conserva su nombre.',
    'members.deactivateTokens': 'Los tokens de API que creó en esta marca se revocan, y siguen revocados aunque la reactives.',
    'members.deactivatedToast': { zero: 'Persona desactivada', one: 'Persona desactivada · {count} token revocado', other: 'Persona desactivada · {count} tokens revocados' },
    'members.reactivateTitle': '¿Reactivar a {name}?',
    'members.reactivateText': 'Vuelve a entrar con su rol de {role}. Los tokens que se revocaron al desactivarla siguen revocados: crea otros si hacen falta.',
    'members.reactivatedToast': 'Persona reactivada',
    'members.deactivatedSection': 'Desactivados',
    'members.deactivatedBy': 'Desactivado por {who} el {date}',
    'members.deactivatedOn': 'Desactivado el {date}',
    'members.cannotSelf': 'No puedes desactivarte a ti mismo: pídeselo a otro administrador.',
    'members.lastAdmin': 'Es el único administrador activo de la marca: haz administrador a otra persona antes.',

    // A person deactivated in a brand.
    'deactivated.title': 'Te han desactivado en {brand}',
    'deactivated.text': 'No puedes abrir esta marca hasta que un administrador te reactive.',
    'deactivated.since': 'Desde el {date}.',
    'deactivated.noBrands': 'No tienes ninguna marca activa',
    'deactivated.where': 'Te han desactivado en {brands}. Pide a un administrador que te reactive.',
    'deactivated.switcher': 'Te han desactivado en',
    'deactivated.banner': 'Te han desactivado en {brand}: no puedes abrirla hasta que un administrador te reactive.',

    // The bell.
    'notif.kind.publication.auto_scheduled': 'El estudio ha programado algo aprobado',
    'notif.kind.publication.handed_over': 'Una publicación ha pasado a hacerse a mano',
    'notif.kind.agent.timed_out': 'Una ejecución del agente se ha quedado sin tiempo',

    // The agent's runs.
    'outcome.scheduled': 'Programó lo aprobado',
  },
  en: {
    'members.deactivate': 'Deactivate',
    'members.reactivate': 'Reactivate',
    'members.deactivateTitle': 'Deactivate {name}?',
    'members.deactivateText': 'They will not be able to open this brand or be told anything about it until you reactivate them. What they did keeps their name.',
    'members.deactivateTokens': 'The API tokens they made in this brand are revoked, and stay revoked if you reactivate them.',
    'members.deactivatedToast': { zero: 'Person deactivated', one: 'Person deactivated · {count} token revoked', other: 'Person deactivated · {count} tokens revoked' },
    'members.reactivateTitle': 'Reactivate {name}?',
    'members.reactivateText': 'They come back as {role}. The tokens revoked when they were deactivated stay revoked: make new ones if needed.',
    'members.reactivatedToast': 'Person reactivated',
    'members.deactivatedSection': 'Deactivated',
    'members.deactivatedBy': 'Deactivated by {who} on {date}',
    'members.deactivatedOn': 'Deactivated on {date}',
    'members.cannotSelf': 'You cannot deactivate yourself: ask another admin to.',
    'members.lastAdmin': 'They are the brand’s only active admin: make someone else an admin first.',

    'deactivated.title': 'You were deactivated in {brand}',
    'deactivated.text': 'You cannot open this brand until an admin reactivates you.',
    'deactivated.since': 'Since {date}.',
    'deactivated.noBrands': 'You have no active brand',
    'deactivated.where': 'You were deactivated in {brands}. Ask an admin to reactivate you.',
    'deactivated.switcher': 'Deactivated in',
    'deactivated.banner': 'You were deactivated in {brand}: you cannot open it until an admin reactivates you.',

    'notif.kind.publication.auto_scheduled': 'The studio scheduled something approved',
    'notif.kind.publication.handed_over': 'A post was handed over to be published by hand',
    'notif.kind.agent.timed_out': 'An agent run ran out of time',

    'outcome.scheduled': 'Scheduled what was approved',
  },
});
