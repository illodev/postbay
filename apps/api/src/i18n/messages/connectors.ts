import { define } from './define.js';

// What a connector says in its own words (not the network's) about a post: kept as codes with the errors and notes it raises.
export const connectors = define({
  es: {
    'connector.ig.publishedNotFound':
      'Instagram dice que este post se ha publicado, pero todavía no aparece entre los últimos de la cuenta: se vuelve a buscar antes de enviar nada.',
    'connector.threads.publishedNotFound':
      'Threads dice que este post se ha publicado, pero todavía no aparece entre los últimos de la cuenta: se vuelve a buscar antes de enviar nada.',

    // Notes from a network's check of a post (the history, and the notification of a post kept private).
    'pub.note.gone.post': '{network} ya no devuelve este post',
    'pub.note.gone.pin': '{network} ya no devuelve este pin',
    'pub.note.gone.video': '{network} ya no devuelve este vídeo',
    'pub.note.youtube.notPublicYet': 'Ya es la hora y YouTube aún no lo ha hecho público; suele hacerlo en pocos minutos',
    'pub.note.youtube.unaudited': 'El vídeo es privado en YouTube porque el proyecto no ha pasado la auditoría: alguien tiene que hacerlo público en YouTube Studio',
    'pub.note.youtube.private': 'El vídeo es privado en YouTube: alguien tiene que hacerlo público en YouTube Studio',
    'pub.note.youtube.stillPrivate': 'El vídeo sigue siendo privado en YouTube 45 minutos después de su hora: alguien tiene que hacerlo público en YouTube Studio',
    'pub.note.pinterest.private': 'El pin está en Pinterest, pero solo lo ve quien lo creó hasta que Pinterest dé a la app el acceso Standard',
    'pub.note.linkedin.state': 'LinkedIn dice que el post está en estado {state}',
    'pub.note.linkedin.notYet': 'LinkedIn dice que el post aún no está publicado',
    'pub.note.tiktok.inbox': 'TikTok ha dejado el post como borrador en la bandeja de entrada de la cuenta: alguien tiene que terminarlo en la app de TikTok',
  },
  en: {
    'connector.ig.publishedNotFound':
      "Instagram says this post was published, but it is not among the account's latest posts yet: it is looked for again before anything is sent.",
    'connector.threads.publishedNotFound':
      "Threads says this post was published, but it is not among the account's latest posts yet: it is looked for again before anything is sent.",

    'pub.note.gone.post': '{network} does not return this post any more',
    'pub.note.gone.pin': '{network} does not return this pin any more',
    'pub.note.gone.video': '{network} does not return this video any more',
    'pub.note.youtube.notPublicYet': 'Its time has come and YouTube has not made it public yet; it usually does within minutes',
    'pub.note.youtube.unaudited': 'The video is private on YouTube, because the project has not passed its audit: a person has to make it public in YouTube Studio',
    'pub.note.youtube.private': 'The video is private on YouTube: a person has to make it public in YouTube Studio',
    'pub.note.youtube.stillPrivate': 'The video is still private on YouTube 45 minutes after its time: a person has to make it public in YouTube Studio',
    'pub.note.pinterest.private': 'The pin is on Pinterest, but only its creator can see it until Pinterest approves the app for Standard access',
    'pub.note.linkedin.state': 'LinkedIn says the post is {state}',
    'pub.note.linkedin.notYet': 'LinkedIn says the post is not published yet',
    'pub.note.tiktok.inbox': "TikTok put the post in the account's inbox as a draft: a person has to finish it in the TikTok app",
  },
});
