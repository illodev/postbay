import { define } from './define.js';

// Deactivating a member of a brand (services/brand.ts): what the person asking is told, and what a deactivated member is told when they
// try to open the brand.
export const members = define({
  es: {
    'member.deactivated': 'Te han desactivado en esta marca: no puedes abrirla hasta que un administrador te reactive',
    'member.cannotDeactivateSelf': 'No puedes desactivarte a ti mismo: pide a otro administrador que lo haga',
    'member.lastActiveAdmin': 'Una marca necesita al menos un administrador activo',
    'member.alreadyDeactivated': 'Ese miembro ya está desactivado',
    'member.notDeactivated': 'Ese miembro no está desactivado',
    'member.existsDeactivated': 'Esa persona ya es miembro de esta marca, pero está desactivada: reactívala en vez de añadirla',
  },
  en: {
    'member.deactivated': 'You have been deactivated in this brand: you cannot open it until an admin reactivates you',
    'member.cannotDeactivateSelf': 'You cannot deactivate yourself: ask another admin to do it',
    'member.lastActiveAdmin': 'A brand needs at least one active admin',
    'member.alreadyDeactivated': 'That member is already deactivated',
    'member.notDeactivated': 'That member is not deactivated',
    'member.existsDeactivated': 'That person is already a member of this brand, but deactivated: reactivate them instead of adding them',
  },
});
