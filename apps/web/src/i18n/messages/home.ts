import { define } from './define';

// "For you": the first screen.
export const home = define({
  es: {
    'home.morning': 'Buenos días, {name}',
    'home.afternoon': 'Buenas tardes, {name}',
    'home.evening': 'Buenas noches, {name}',
    'home.waiting': { zero: 'No hay nada esperando tu revisión.', one: 'Hay {count} pieza esperando revisión.', other: 'Hay {count} piezas esperando revisión.' },
    'home.nothing': 'Todo al día',
  },
  en: {
    'home.morning': 'Good morning, {name}',
    'home.afternoon': 'Good afternoon, {name}',
    'home.evening': 'Good evening, {name}',
    'home.waiting': { zero: 'Nothing is waiting for review.', one: '{count} piece is waiting for review.', other: '{count} pieces are waiting for review.' },
    'home.nothing': 'All caught up',
  },
});
