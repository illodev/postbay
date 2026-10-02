import { define } from './define.js';

// Names the other messages put inside themselves: roles, networks, and the state of a publication as a word in a sentence.
export const common = define({
  es: {
    'role.admin': 'administrador',
    'role.approver': 'aprobador',
    'role.reviewer': 'revisor',
    'role.producer': 'productor',
    'role.reader': 'lector',

    'pubState.cancelled': 'cancelada',
    'pubState.failed': 'fallida',
    'pubState.on_hold': 'en espera',
    'pubState.scheduled': 'programada',
    'pubState.published': 'publicada',

    'network.instagram': 'Instagram',
    'network.facebook': 'Facebook',
    'network.youtube': 'YouTube',
    'network.tiktok': 'TikTok',
    'network.linkedin': 'LinkedIn',
    'network.x': 'X',
    'network.threads': 'Threads',
    'network.pinterest': 'Pinterest',
    'network.bluesky': 'Bluesky',

    'common.someone': 'Alguien',
    'common.anAdmin': 'Un administrador',
    'common.serverOperator': 'Quien gestiona el servidor',
  },
  en: {
    'role.admin': 'admin',
    'role.approver': 'approver',
    'role.reviewer': 'reviewer',
    'role.producer': 'producer',
    'role.reader': 'reader',

    'pubState.cancelled': 'cancelled',
    'pubState.failed': 'failed',
    'pubState.on_hold': 'on hold',
    'pubState.scheduled': 'scheduled',
    'pubState.published': 'published',

    'network.instagram': 'Instagram',
    'network.facebook': 'Facebook',
    'network.youtube': 'YouTube',
    'network.tiktok': 'TikTok',
    'network.linkedin': 'LinkedIn',
    'network.x': 'X',
    'network.threads': 'Threads',
    'network.pinterest': 'Pinterest',
    'network.bluesky': 'Bluesky',

    'common.someone': 'Someone',
    'common.anAdmin': 'An admin',
    'common.serverOperator': 'Whoever runs the server',
  },
});
