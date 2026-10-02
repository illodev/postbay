import { define } from './define.js';

// What a connector says in its own words (not the network's) about a post: kept as codes with the errors and notes it raises.
export const connectors = define({
  es: {
    'connector.ig.publishedNotFound':
      'Instagram dice que este post se ha publicado, pero todavía no aparece entre los últimos de la cuenta: se vuelve a buscar antes de enviar nada.',
    'connector.threads.publishedNotFound':
      'Threads dice que este post se ha publicado, pero todavía no aparece entre los últimos de la cuenta: se vuelve a buscar antes de enviar nada.',
  },
  en: {
    'connector.ig.publishedNotFound':
      "Instagram says this post was published, but it is not among the account's latest posts yet: it is looked for again before anything is sent.",
    'connector.threads.publishedNotFound':
      "Threads says this post was published, but it is not among the account's latest posts yet: it is looked for again before anything is sent.",
  },
});
