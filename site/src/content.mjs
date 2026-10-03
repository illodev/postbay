// The landing's words, in English and Spanish. build.mjs puts them into the page.

export const content = {
  en: {
    lang: 'en',
    title: 'Postbay — review, approve and publish social content, with your team and your AI agents',
    description: 'Open-source, self-hosted studio for social content: frame-accurate review, approvals bound to the exact file, a calendar that publishes to nine networks, and an MCP server for Claude.',
    nav: { features: 'Features', agents: 'Agents', claude: 'Claude', selfhost: 'Self-host', docs: 'Docs', github: 'GitHub' },
    hero: {
      eyebrow: 'Open source · Self-hosted',
      title: 'Review, approve and publish your social content.',
      lead: 'With your team and your AI agents. Comments on the exact frame, approvals bound to the exact file, and a calendar that publishes to nine networks. On your own server.',
      primary: 'Self-host Postbay',
      secondary: 'View on GitHub',
      cards: {
        comment: { who: 'Maya', text: 'The 212° is shouting over the title.' },
        agent: { who: 'Agent', text: 'Fixed in v2: smaller, under the title.' },
        approved: 'Approved for @lumen.coffee',
      },
    },
    networks: 'Publishes to',
    features: {
      review: {
        kicker: 'Review',
        title: 'Feedback on the exact frame',
        text: 'Comment on a moment or a span of a video, a point of an image, a page of a PDF, and draw on it. Compare versions side by side or with a wipe, and see what each network’s own interface will cover.',
        points: ['Timecoded comments and drawings', 'Side-by-side and wipe compare', 'What Reels, Shorts and TikTok cover'],
      },
      approve: {
        kicker: 'Approve',
        title: 'Approvals that mean something',
        text: 'An approval is bound to the fingerprint of the exact files you looked at. Change one byte and it no longer counts. Nobody approves their own upload, and open comments block an approval.',
        fingerprint: 'Fingerprint',
        approvedFor: 'Approved for',
        changed: 'One byte changed: the approval no longer counts.',
      },
      publish: {
        kicker: 'Publish',
        title: 'A calendar that publishes by itself',
        text: 'Weekly slots, blocked dates and a pause button. Postbay publishes to Instagram, Facebook, YouTube, TikTok, LinkedIn, X, Threads, Pinterest and Bluesky, or gets everything ready for a person to post. Then it reads what each post earned.',
        points: ['Free slots that ask for content', 'Automatic or assisted publishing', 'Results per network, never added up'],
      },
    },
    agents: {
      kicker: 'Agents',
      title: 'Made for AI agents, with guardrails',
      text: 'A request for changes can become a new version without anyone’s hands. Signed webhooks wake an agent runner, the agent works through the comments, uploads the next version and answers each one: fixed, cannot do, or needs a person.',
      points: ['Budgets per piece and per month', 'A limit of rounds, then a person', 'Comments only people can answer', 'An agent never approves'],
      dbc: {
        title: 'Pairs with drawn-by-code',
        text: 'Videos made with code by Claude, not generated. When a piece comes from a drawn-by-code project, the agent edits the project, renders it again and uploads the result as the next version.',
        link: 'Meet drawn-by-code',
      },
    },
    claude: {
      kicker: 'Claude',
      title: 'Do it from Claude',
      text: 'Postbay is an MCP server. Ask Claude what is pending, leave comments, upload a folder of videos or plan the week. It signs in as you, with your role. No keys to copy.',
      install: 'Install the Claude Code plugin',
      terminal: {
        ask: 'What is pending for me in Postbay?',
        answer: ['3 versions wait for your approval:', '  Meet our roasters · v2 by the agent · 1 open comment', '  Latte art, step by step · v1 · 1 open comment', '  The home brewing guide · v1', 'Pumpkin spice is back goes out Tuesday at 19:00 on @lumen.coffee.'],
      },
    },
    selfhost: {
      kicker: 'Self-host',
      title: 'Yours, on your own server',
      text: 'One Docker Compose file runs it all: the app, a worker, PostgreSQL, S3-compatible storage and automatic TLS. Your files and your accounts never leave your machine.',
      docs: 'Read the deployment guide',
    },
    footer: {
      oss: 'Postbay is open source.',
      by: 'Made by illodev.',
      sister: 'Sister project:',
    },
    switchTo: { label: 'Español', href: '/es/' },
    img: 'en',
  },
  es: {
    lang: 'es',
    title: 'Postbay — revisa, aprueba y publica contenido para redes, con tu equipo y tus agentes de IA',
    description: 'Estudio de contenido para redes, de código abierto y en tu propio servidor: revisión al fotograma, aprobaciones ligadas al archivo exacto, un calendario que publica en nueve redes y un servidor MCP para Claude.',
    nav: { features: 'Funciones', agents: 'Agentes', claude: 'Claude', selfhost: 'Instalar', docs: 'Documentación', github: 'GitHub' },
    hero: {
      eyebrow: 'Código abierto · En tu servidor',
      title: 'Revisa, aprueba y publica tu contenido para redes.',
      lead: 'Con tu equipo y con tus agentes de IA. Comentarios en el fotograma exacto, aprobaciones ligadas al archivo exacto y un calendario que publica en nueve redes. En tu propio servidor.',
      primary: 'Instala Postbay',
      secondary: 'Ver en GitHub',
      cards: {
        comment: { who: 'Maya', text: 'El 212° grita más que el título.' },
        agent: { who: 'Agente', text: 'Arreglado en la v2: más pequeño, bajo el título.' },
        approved: 'Aprobada para @lumen.coffee',
      },
    },
    networks: 'Publica en',
    features: {
      review: {
        kicker: 'Revisar',
        title: 'Comentarios en el fotograma exacto',
        text: 'Comenta un momento o un tramo de un vídeo, un punto de una imagen o una página de un PDF, y dibuja encima. Compara versiones lado a lado o con una cortinilla, y mira qué tapa la interfaz de cada red.',
        points: ['Comentarios y dibujos con su segundo', 'Comparar lado a lado o con cortinilla', 'Lo que tapan Reels, Shorts y TikTok'],
      },
      approve: {
        kicker: 'Aprobar',
        title: 'Aprobaciones que valen algo',
        text: 'Una aprobación queda ligada a la huella de los archivos exactos que viste. Si cambia un solo byte, deja de contar. Nadie aprueba lo que ha subido, y con comentarios abiertos no se aprueba.',
        fingerprint: 'Huella',
        approvedFor: 'Aprobada para',
        changed: 'Ha cambiado un byte: la aprobación ya no cuenta.',
      },
      publish: {
        kicker: 'Publicar',
        title: 'Un calendario que publica solo',
        text: 'Huecos semanales, días bloqueados y un botón de pausa. Postbay publica en Instagram, Facebook, YouTube, TikTok, LinkedIn, X, Threads, Pinterest y Bluesky, o lo deja todo listo para que lo publique una persona. Después lee lo que consiguió cada publicación.',
        points: ['Huecos libres que piden contenido', 'Publicación automática o asistida', 'Resultados por red, nunca sumados'],
      },
    },
    agents: {
      kicker: 'Agentes',
      title: 'Hecho para agentes de IA, con límites',
      text: 'Una petición de cambios puede convertirse en una versión nueva sin que nadie toque nada. Los webhooks firmados despiertan al agente, que trabaja los comentarios, sube la siguiente versión y contesta cada uno: arreglado, no se puede o necesita a una persona.',
      points: ['Presupuesto por pieza y por mes', 'Un límite de rondas y, después, una persona', 'Comentarios que solo responden personas', 'Un agente nunca aprueba'],
      dbc: {
        title: 'Encaja con drawn-by-code',
        text: 'Vídeos hechos con código por Claude, no generados. Cuando una pieza sale de un proyecto de drawn-by-code, el agente cambia el proyecto, vuelve a renderizarlo y sube el resultado como la siguiente versión.',
        link: 'Conoce drawn-by-code',
      },
    },
    claude: {
      kicker: 'Claude',
      title: 'Hazlo desde Claude',
      text: 'Postbay es un servidor MCP. Pregúntale a Claude qué tienes pendiente, deja comentarios, sube una carpeta de vídeos o planifica la semana. Entra como tú y con tu rol. Sin claves que copiar.',
      install: 'Instala el plugin de Claude Code',
      terminal: {
        ask: '¿Qué tengo pendiente en Postbay?',
        answer: ['3 versiones esperan tu aprobación:', '  Meet our roasters · v2 del agente · 1 comentario abierto', '  Latte art, step by step · v1 · 1 comentario abierto', '  The home brewing guide · v1', 'Pumpkin spice is back sale el martes a las 19:00 en @lumen.coffee.'],
      },
    },
    selfhost: {
      kicker: 'Instalar',
      title: 'Tuyo, en tu propio servidor',
      text: 'Un único Docker Compose lo levanta todo: la app, un worker, PostgreSQL, almacenamiento compatible con S3 y TLS automático. Tus archivos y tus cuentas no salen de tu máquina.',
      docs: 'Lee la guía de despliegue',
    },
    footer: {
      oss: 'Postbay es de código abierto.',
      by: 'Hecho por illodev.',
      sister: 'Proyecto hermano:',
    },
    switchTo: { label: 'English', href: '/' },
    img: 'es',
  },
};
