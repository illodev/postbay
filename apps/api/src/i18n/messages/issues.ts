import { define } from './define.js';

// What scheduling says about a post before it goes out (connectors/validate.ts and each connector's validate()), and the names of the
// placements and the network's own settings the schedule dialog shows (connectors/labels.ts).
//
// `issue.<code>` is an issue's wording; `issue.<code>.<variant>` is a network's own wording of the same problem (its `variant` param).
// `{placement}` is one of the `placement.*` names; `{network}` a network's name; numbers come as they are to be read.
export const issues = define({
  es: {
    'issue.word.file': 'archivo',
    'issue.word.files': 'archivos',
    'issue.word.videos': 'vídeos',
    'issue.word.images': 'imágenes',

    // The checks every network shares.
    'issue.placement.unknown': '{network} no puede publicar como «{placement}»',
    'issue.media.count.exact': '«{placement}» lleva exactamente {min} {files}; esta versión tiene {count}',
    'issue.media.count.range': '«{placement}» lleva de {min} a {max} {files}; esta versión tiene {count}',
    'issue.media.kind': '«{placement}» no admite {kind} ({name})',
    'issue.media.aspect': '{name} mide {width}×{height}; «{placement}» necesita una proporción de ancho a alto entre {min} y {max}',
    'issue.media.aspect.recommended': '{name} mide {width}×{height}; «{placement}» queda mejor entre {min} y {max}',
    'issue.media.duration': '{name} dura {seconds} s; «{placement}» admite de {min} a {max} s',
    'issue.text.length': 'El texto tiene {count} caracteres; {network} admite {max}',
    'issue.text.hashtags': 'El texto tiene {count} hashtags; {network} admite {max}',
    'issue.text.mentions': 'El texto menciona {count} cuentas; {network} admite {max}',
    'issue.firstComment.unsupported': '{network} no puede publicar un primer comentario: no se enviará',
    'issue.firstComment.length': 'El primer comentario tiene {count} caracteres; {network} admite {max}',

    // Instagram
    'issue.story.text': 'Las stories de Instagram no llevan texto: no se enviará',
    'issue.carousel.video.length':
      '{name} dura {seconds} s. La referencia de Meta no da una duración para un vídeo de un carrusel, y los vídeos del feed tenían un límite de 60 segundos: puede que Instagram lo rechace.',

    // YouTube
    'issue.title.length': 'El título tiene {count} caracteres; YouTube admite {max}. Acorta el título de la pieza.',
    'issue.text.bytes':
      'YouTube cuenta la descripción en bytes: esta ocupa {bytes} de {max} (las letras con tilde ocupan dos, los emojis cuatro, y cada < o > se envía como ‹ o ›, que ocupan tres). Acórtala.',
    'issue.text.angle': 'YouTube no admite < ni > en una descripción: se enviarán como ‹ y ›.',
    'issue.youtube.made_for_kids':
      'Nadie ha dicho si este vídeo es para niños. YouTube exige esa declaración: elígela aquí (o pon el valor por defecto del canal en Ajustes → Cuentas); si no, YouTube aplica el ajuste del propio canal, y si no hay ninguno lo pide en YouTube Studio.',
    'issue.youtube.unaudited':
      'Este proyecto de YouTube aún no ha pasado la auditoría de cumplimiento de Google: el vídeo se subirá como privado y alguien tendrá que hacerlo público en YouTube Studio.',

    // TikTok
    'issue.tiktok.privacy': 'Elige quién puede ver este post. TikTok pide que nadie lo elija por ti.',
    'issue.tiktok.privacy.unavailable': 'TikTok no ofrece «{choice}» para esta cuenta. Elige una de estas: {choices}.',
    'issue.tiktok.commercial': 'Has dicho que el post promociona algo: indica si es tu propia marca, contenido de marca o ambos.',
    'issue.tiktok.branded.private': 'En TikTok, el contenido de marca no puede ser privado.',
    'issue.tiktok.consent.branded': 'TikTok pide esta conformidad para el contenido de marca: «{notice}»',
    'issue.tiktok.consent': 'TikTok pide esta conformidad antes de publicar: «{notice}»',
    'issue.tiktok.allowComment.disabled': 'Los comentarios están desactivados para esta cuenta en TikTok, así que no se pueden permitir en este post.',
    'issue.tiktok.allowDuet.disabled': 'Los dúos están desactivados para esta cuenta en TikTok, así que no se pueden permitir en este post.',
    'issue.tiktok.allowStitch.disabled': 'Los stitches están desactivados para esta cuenta en TikTok, así que no se pueden permitir en este post.',
    'issue.tiktok.duration': 'Esta cuenta puede publicar en TikTok vídeos de hasta {max} segundos; este dura {seconds}.',
    'issue.tiktok.unaudited':
      'Esta app de TikTok aún no ha pasado la auditoría de TikTok: el post se publicará como privado (solo lo verá la cuenta) elijas lo que elijas arriba, TikTok solo lo acepta si la propia cuenta de TikTok está en privado en sus ajustes, y alguien tendrá que hacerlo público en TikTok.',
    'issue.tiktok.photo.domain':
      'TikTok descarga las fotos él mismo, y solo de un dominio verificado en su portal de desarrolladores. Si el dominio de los archivos no está verificado allí, lo rechazará.',

    // LinkedIn
    'issue.media.count.linkedinDocument': 'Un documento de LinkedIn necesita exactamente un PDF en esta versión',
    'issue.media.size': '{name} pesa más de 100 MB, que es lo que LinkedIn admite para un documento',
    'issue.document.extra': 'Las imágenes y los vídeos de esta versión no se envían: solo se publica el PDF como documento',

    // X
    'issue.text.length.x': 'X cuenta este texto como {count} de 280 (una dirección cuenta 23, y algunos caracteres, entre ellos los emojis, cuentan dos)',
    'issue.firstComment.length.x': 'X cuenta el primer comentario como {count} de 280',
    'issue.x.link.cost':
      'En X, un post con un enlace cuesta {linkCost} USD en vez de {postCost} USD, 13 veces más (X también convierte en enlace un dominio suelto como {link}). Una respuesta con el enlace cuesta lo mismo, así que pasarlo al primer comentario no ahorra nada: quítalo, o ponlo en el perfil.',
    'issue.x.link.cost.comment': 'El primer comentario lleva un enlace ({link}): X cobra {linkCost} USD por una respuesta con enlace, igual que por un post.',

    // Pinterest
    'issue.title.missing': 'Un pin necesita un título: ponle uno a la pieza, o escríbelo en las opciones del pin',
    'issue.link.invalid': '«{link}» no es una dirección web que Pinterest pueda usar como enlace del pin',
    'issue.cover.missing': 'Un pin de vídeo necesita una imagen de portada: añádela a esta versión',
    'issue.pinterest.trial':
      'Esta app de Pinterest tiene acceso de prueba (Trial): el pin se creará, pero solo lo verás tú hasta que Pinterest le dé acceso Standard.',

    // Bluesky
    'issue.bluesky.email': 'Bluesky solo acepta vídeos de cuentas con el correo confirmado. Confírmalo en los ajustes de la cuenta.',

    // The ways of posting each network has.
    'placement.instagram.reel': 'Reel',
    'placement.instagram.feed_image': 'Foto del feed',
    'placement.instagram.carousel': 'Carrusel',
    'placement.instagram.story': 'Story',
    'placement.facebook.photo': 'Post con foto',
    'placement.facebook.photos': 'Post con álbum de fotos',
    'placement.facebook.video': 'Post con vídeo',
    'placement.facebook.reel': 'Reel',
    'placement.youtube.video': 'Vídeo',
    'placement.youtube.short': 'Short',
    'placement.tiktok.video': 'Vídeo',
    'placement.tiktok.photo': 'Fotos',
    'placement.linkedin.image': 'Imagen',
    'placement.linkedin.images': 'Varias imágenes',
    'placement.linkedin.video': 'Vídeo',
    'placement.linkedin.document': 'Documento (PDF)',
    'placement.x.images': 'Imágenes',
    'placement.x.video': 'Vídeo',
    'placement.threads.image': 'Imagen',
    'placement.threads.video': 'Vídeo',
    'placement.threads.carousel': 'Carrusel',
    'placement.pinterest.image_pin': 'Pin',
    'placement.pinterest.carousel_pin': 'Pin carrusel',
    'placement.pinterest.video_pin': 'Pin de vídeo',
    'placement.bluesky.images': 'Imágenes',
    'placement.bluesky.video': 'Vídeo',

    // Each network's own settings in the schedule dialog. TikTok's agreements (`notice`) are TikTok's own words and are never translated.
    'option.altText.label': 'Descripción de la imagen (texto alternativo)',
    'option.altText.help': 'Se lee en voz alta a quien no puede ver la imagen.',
    'option.altText.helpEvery': 'Se lee en voz alta a quien no puede ver la imagen. Se usa para todas las imágenes del post.',
    'option.titleFallback.help': 'Si lo dejas vacío, se usa el título de la pieza.',

    'option.youtube.madeForKids.label': '¿Este vídeo es para niños?',
    'option.youtube.madeForKids.help':
      'YouTube pide esta declaración para cada vídeo (por la ley de privacidad infantil, COPPA). Si el canal tiene un valor por defecto en Ajustes → Cuentas, se rellena con él.',
    'option.youtube.madeForKids.choice.no': 'No, no es para niños',
    'option.youtube.madeForKids.choice.yes': 'Sí, es para niños',

    'option.pinterest.title.label': 'Título del pin',
    'option.pinterest.link.label': 'Enlace de destino',
    'option.pinterest.link.help': 'Adónde lleva un clic en el pin.',

    'option.linkedin.title.label': 'Título del vídeo o del documento',
    'option.linkedin.title.help': 'Sale encima de un documento y en un vídeo. Si lo dejas vacío, se usa el título de la pieza.',

    'option.tiktok.creator.label': 'Se publica en TikTok como {name}',
    'option.tiktok.privacy.label': 'Quién puede ver este post',
    'option.tiktok.privacy.help': 'TikTok pide que nadie lo elija por ti.',
    'option.tiktok.privacy.helpUnaudited':
      'TikTok pide que nadie lo elija por ti. Hasta que TikTok audite esta app, solo acepta posts que únicamente ve la cuenta («Solo yo»), y solo de una cuenta de TikTok que esté en privado en sus ajustes.',
    'option.tiktok.privacy.choice.SELF_ONLY': 'Solo yo',
    'option.tiktok.privacy.choice.MUTUAL_FOLLOW_FRIENDS': 'Amigos',
    'option.tiktok.privacy.choice.FOLLOWER_OF_CREATOR': 'Seguidores',
    'option.tiktok.privacy.choice.PUBLIC_TO_EVERYONE': 'Todos',
    'option.tiktok.allowComment.label': 'Permitir comentarios',
    'option.tiktok.allowComment.off': 'Los comentarios están desactivados para esta cuenta en los ajustes de TikTok.',
    'option.tiktok.allowDuet.label': 'Permitir dúos',
    'option.tiktok.allowDuet.off': 'Los dúos están desactivados para esta cuenta en los ajustes de TikTok.',
    'option.tiktok.allowStitch.label': 'Permitir stitches',
    'option.tiktok.allowStitch.off': 'Los stitches están desactivados para esta cuenta en los ajustes de TikTok.',
    'option.tiktok.commercial.label': 'Este post promociona una marca, un producto o un servicio',
    'option.tiktok.commercial.help': 'Indica si es tu propia marca, contenido de marca o ambos.',
    'option.tiktok.yourBrand.label': 'Tu marca',
    'option.tiktok.yourBrand.help': 'Te promocionas a ti o a tu propio negocio. TikTok le pondrá al post la etiqueta «Promotional content».',
    'option.tiktok.brandedContent.label': 'Contenido de marca',
    'option.tiktok.brandedContent.help': 'Promocionas otra marca o a un tercero. TikTok le pondrá al post la etiqueta «Paid partnership», y no puede ser privado.',
    'option.tiktok.consent.label': 'Acepto',
    'option.tiktok.consentBranded.label': 'Acepto',
    'option.tiktok.title.label': 'Título de las fotos',
    'option.tiktok.maxDuration.label': 'Esta cuenta puede publicar vídeos de hasta {seconds} segundos.',
    'option.tiktok.processing.label': 'Después de enviarlo, TikTok puede tardar unos minutos en procesar el post antes de que salga en el perfil.',
  },
  en: {
    'issue.word.file': 'file',
    'issue.word.files': 'files',
    'issue.word.videos': 'videos',
    'issue.word.images': 'images',

    'issue.placement.unknown': '{network} cannot publish as "{placement}"',
    'issue.media.count.exact': '{placement} takes exactly {min} {files}; this version has {count}',
    'issue.media.count.range': '{placement} takes {min} to {max} {files}; this version has {count}',
    'issue.media.kind': '{placement} does not take {kind} ({name})',
    'issue.media.aspect': '{name} is {width}×{height}; {placement} needs a width-to-height ratio between {min} and {max}',
    'issue.media.aspect.recommended': '{name} is {width}×{height}; {placement} looks best between {min} and {max}',
    'issue.media.duration': '{name} runs {seconds} s; {placement} takes {min} to {max} s',
    'issue.text.length': 'The text has {count} characters; {network} allows {max}',
    'issue.text.hashtags': 'The text has {count} hashtags; {network} allows {max}',
    'issue.text.mentions': 'The text mentions {count} accounts; {network} allows {max}',
    'issue.firstComment.unsupported': '{network} cannot post a first comment; it will be left out',
    'issue.firstComment.length': 'The first comment has {count} characters; {network} allows {max}',

    'issue.story.text': 'Instagram Stories take no caption: the text will be left out',
    'issue.carousel.video.length':
      "{name} runs {seconds} s. Meta's reference gives no length for a video in a carousel, and feed videos were limited to 60 seconds: Instagram may refuse it.",

    'issue.title.length': 'The title has {count} characters; YouTube allows {max}. Shorten the piece title.',
    'issue.text.bytes':
      'YouTube counts the description in bytes: this one takes {bytes} of {max} (accented letters take two, emoji four, and each < or > is sent as ‹ or ›, three). Shorten it.',
    'issue.text.angle': 'YouTube does not allow < or > in a description: they will be sent as ‹ and ›.',
    'issue.youtube.made_for_kids':
      "Nobody has said whether this video is made for kids. YouTube requires that declaration: choose it here (or set the channel's default in Settings → Accounts); otherwise YouTube applies the channel's own setting, and asks for it in YouTube Studio if there is none.",
    'issue.youtube.unaudited':
      "This YouTube project has not passed Google's compliance audit yet: the video will be uploaded as private, and a person has to make it public in YouTube Studio.",

    'issue.tiktok.privacy': 'Choose who can see this post. TikTok asks that nobody is chosen for you.',
    'issue.tiktok.privacy.unavailable': 'TikTok does not offer "{choice}" for this account. Choose one of: {choices}.',
    'issue.tiktok.commercial': 'You said the post promotes something: say whether it is your own brand, branded content, or both.',
    'issue.tiktok.branded.private': 'Branded content cannot be private on TikTok.',
    'issue.tiktok.consent.branded': 'TikTok needs this agreement for branded content: "{notice}"',
    'issue.tiktok.consent': 'TikTok needs this agreement before posting: "{notice}"',
    'issue.tiktok.allowComment.disabled': 'Comments are turned off for this account in TikTok, so they cannot be allowed on this post.',
    'issue.tiktok.allowDuet.disabled': 'Duets are turned off for this account in TikTok, so they cannot be allowed on this post.',
    'issue.tiktok.allowStitch.disabled': 'Stitches are turned off for this account in TikTok, so they cannot be allowed on this post.',
    'issue.tiktok.duration': 'This account can post videos of up to {max} seconds on TikTok; this one is {seconds}.',
    'issue.tiktok.unaudited':
      "This TikTok app has not passed TikTok's audit yet: the post will be made private (visible only to the account) whatever is chosen above, TikTok only takes it if the TikTok account itself is set to private in its settings, and a person has to make the post public in TikTok.",
    'issue.tiktok.photo.domain':
      'TikTok downloads photos itself, and only from a domain verified in its developer portal. If the media domain is not verified there, this will be refused.',

    'issue.media.count.linkedinDocument': 'A LinkedIn document needs exactly one PDF in this version',
    'issue.media.size': '{name} is larger than 100 MB, which is what LinkedIn takes for a document',
    'issue.document.extra': 'The pictures and videos in this version are not sent: only the PDF is posted as a document',

    'issue.text.length.x': 'X counts this text as {count} of 280 (an address counts 23, and some characters, emoji among them, count two)',
    'issue.firstComment.length.x': 'X counts the first comment as {count} of 280',
    'issue.x.link.cost':
      'A post with a link costs {linkCost} USD on X instead of {postCost} USD, 13 times more (X also makes a link of a bare domain such as {link}). A reply with the link costs the same, so moving it to the first comment saves nothing: leave it out, or put it in the profile.',
    'issue.x.link.cost.comment': 'The first comment has a link ({link}): X charges a reply with a link {linkCost} USD, as it does a post.',

    'issue.title.missing': 'A pin needs a title: give the piece one, or write one under the pin options',
    'issue.link.invalid': '"{link}" is not a web address Pinterest can use as the pin\'s link',
    'issue.cover.missing': 'A video pin needs a cover picture: add one to this version',
    'issue.pinterest.trial':
      'This Pinterest app is on Trial access: the pin will be created, but only you can see it until Pinterest approves the app for Standard access.',

    'issue.bluesky.email': "Bluesky only takes video from accounts whose email address is confirmed. Confirm it in the account's settings.",

    'placement.instagram.reel': 'Reel',
    'placement.instagram.feed_image': 'Feed photo',
    'placement.instagram.carousel': 'Carousel',
    'placement.instagram.story': 'Story',
    'placement.facebook.photo': 'Photo post',
    'placement.facebook.photos': 'Photo album post',
    'placement.facebook.video': 'Video post',
    'placement.facebook.reel': 'Reel',
    'placement.youtube.video': 'Video',
    'placement.youtube.short': 'Short',
    'placement.tiktok.video': 'Video',
    'placement.tiktok.photo': 'Photos',
    'placement.linkedin.image': 'Picture',
    'placement.linkedin.images': 'Several pictures',
    'placement.linkedin.video': 'Video',
    'placement.linkedin.document': 'Document (PDF)',
    'placement.x.images': 'Pictures',
    'placement.x.video': 'Video',
    'placement.threads.image': 'Picture',
    'placement.threads.video': 'Video',
    'placement.threads.carousel': 'Carousel',
    'placement.pinterest.image_pin': 'Pin',
    'placement.pinterest.carousel_pin': 'Carousel pin',
    'placement.pinterest.video_pin': 'Video pin',
    'placement.bluesky.images': 'Pictures',
    'placement.bluesky.video': 'Video',

    'option.altText.label': 'Description of the picture (alt text)',
    'option.altText.help': 'Read aloud to people who cannot see the picture.',
    'option.altText.helpEvery': 'Read aloud to people who cannot see the picture. It is used for every picture of the post.',
    'option.titleFallback.help': 'The title of the piece is used if this is empty.',

    'option.youtube.madeForKids.label': 'Is this video made for kids?',
    'option.youtube.madeForKids.help':
      "YouTube requires this declaration for every video (children's privacy law, COPPA). The channel's default is filled in when one is set in Settings → Accounts.",
    'option.youtube.madeForKids.choice.no': "No, it's not made for kids",
    'option.youtube.madeForKids.choice.yes': "Yes, it's made for kids",

    'option.pinterest.title.label': 'Pin title',
    'option.pinterest.link.label': 'Destination link',
    'option.pinterest.link.help': 'Where a click on the pin goes.',

    'option.linkedin.title.label': 'Title of the video or document',
    'option.linkedin.title.help': 'Shown above a document and on a video. The title of the piece is used if this is empty.',

    'option.tiktok.creator.label': 'Posting to TikTok as {name}',
    'option.tiktok.privacy.label': 'Who can see this post',
    'option.tiktok.privacy.help': 'TikTok asks that nobody is chosen for you.',
    'option.tiktok.privacy.helpUnaudited':
      'TikTok asks that nobody is chosen for you. Until TikTok audits this app, it only takes posts that only the account can see ("Only me"), and only from a TikTok account that is itself set to private in TikTok\'s settings.',
    'option.tiktok.privacy.choice.SELF_ONLY': 'Only me',
    'option.tiktok.privacy.choice.MUTUAL_FOLLOW_FRIENDS': 'Friends',
    'option.tiktok.privacy.choice.FOLLOWER_OF_CREATOR': 'Followers',
    'option.tiktok.privacy.choice.PUBLIC_TO_EVERYONE': 'Everyone',
    'option.tiktok.allowComment.label': 'Allow comments',
    'option.tiktok.allowComment.off': "Comments are turned off for this account in TikTok's own settings.",
    'option.tiktok.allowDuet.label': 'Allow duets',
    'option.tiktok.allowDuet.off': "Duets are turned off for this account in TikTok's own settings.",
    'option.tiktok.allowStitch.label': 'Allow stitches',
    'option.tiktok.allowStitch.off': "Stitches are turned off for this account in TikTok's own settings.",
    'option.tiktok.commercial.label': 'This post promotes a brand, product or service',
    'option.tiktok.commercial.help': 'Say whether it is your own brand, branded content, or both.',
    'option.tiktok.yourBrand.label': 'Your brand',
    'option.tiktok.yourBrand.help': "You are promoting yourself or your own business. The post will be labelled 'Promotional content'.",
    'option.tiktok.brandedContent.label': 'Branded content',
    'option.tiktok.brandedContent.help': "You are promoting another brand or a third party. The post will be labelled 'Paid partnership', and it cannot be private.",
    'option.tiktok.consent.label': 'I agree',
    'option.tiktok.consentBranded.label': 'I agree',
    'option.tiktok.title.label': 'Title of the photos',
    'option.tiktok.maxDuration.label': 'This account can post videos of up to {seconds} seconds.',
    'option.tiktok.processing.label': 'After it is sent, TikTok can take a few minutes to process the post before it shows on the profile.',
  },
});
