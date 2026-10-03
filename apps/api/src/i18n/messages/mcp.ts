import { define } from './define.js';

// AI assistants connected over MCP (src/mcp/): what the person is told on the consent page and in their settings, and what an assistant
// is told when it is refused (it passes that on to the person, so it is written for them).
export const mcp = define({
  es: {
    'mcp.approvalOff': 'En esta marca no se puede aprobar ni pedir cambios desde un asistente. Un administrador puede permitirlo en Ajustes → Asistentes (MCP).',
    'mcp.confirmMismatch': 'La confirmación no coincide con la versión actual: es la v{number} de «{title}», con huella {fingerprint}. Confírmalo de nuevo con la persona antes de seguir.',
    'mcp.brandRequired': 'Este asistente puede usar varias marcas ({brands}): di en cuál.',
    'mcp.unknownBrand': 'Este asistente no puede usar ninguna marca «{brand}». Puede usar: {brands}.',
    'mcp.noBrands': 'Este asistente no tiene acceso a ninguna marca en la que sigas activo.',
    'mcp.unknownCampaign': 'No hay ninguna campaña «{campaign}» en esta marca.',
    'mcp.badTime': 'No entiendo la hora «{at}». Usa AAAA-MM-DDTHH:mm, en la hora de la marca, o una fecha ISO con su zona.',
    'mcp.request.gone': 'Esta solicitud de acceso ha caducado o ya se ha respondido. Vuelve a conectar el asistente desde su aplicación.',
    'mcp.request.stale': 'La página de autorización ha cambiado. Recárgala y vuelve a intentarlo.',
    'mcp.request.noBrands': 'Elige al menos una de tus marcas.',
    'mcp.connection.notFound': 'Esa conexión no existe o ya está desconectada.',
    'mcp.style.unknown': '«{style}» no es un estilo de esta marca. Puede ser uno de estos: {styles}. Si es uno nuevo, pregúntale a la persona si lo añade a la marca (add_variant_style; solo administradores).',
    'mcp.style.noneDefined': 'Esta marca no tiene estilos de variante. Deja el estilo vacío, o pregúntale a la persona si añade «{style}» a la marca (add_variant_style; solo administradores).',
    'mcp.style.notInList': '«{style}» no está en la lista de estilos de esta marca: {styles}.',
  },
  en: {
    'mcp.approvalOff': 'In this brand an assistant cannot approve or request changes. An admin can allow it in Settings → Assistants (MCP).',
    'mcp.confirmMismatch': 'The confirmation does not match the current version: it is v{number} of “{title}”, fingerprint {fingerprint}. Confirm it again with the person before going on.',
    'mcp.brandRequired': 'This assistant can use several brands ({brands}): say which one.',
    'mcp.unknownBrand': 'This assistant cannot use any brand “{brand}”. It can use: {brands}.',
    'mcp.noBrands': 'This assistant has no access to any brand you are still active in.',
    'mcp.unknownCampaign': 'There is no campaign “{campaign}” in this brand.',
    'mcp.badTime': 'I do not understand the time “{at}”. Use YYYY-MM-DDTHH:mm, in the brand’s time, or an ISO date with its zone.',
    'mcp.request.gone': 'This access request has expired or has already been answered. Connect the assistant again from its own app.',
    'mcp.request.stale': 'The authorization page has changed. Reload it and try again.',
    'mcp.request.noBrands': 'Choose at least one of your brands.',
    'mcp.connection.notFound': 'That connection does not exist or is already disconnected.',
    'mcp.style.unknown': '“{style}” is not one of this brand’s styles. It can be one of these: {styles}. If it is a new one, ask the person whether to add it to the brand (add_variant_style; admins only).',
    'mcp.style.noneDefined': 'This brand has no variant styles. Leave the style empty, or ask the person whether to add “{style}” to the brand (add_variant_style; admins only).',
    'mcp.style.notInList': '“{style}” is not in this brand’s list of styles: {styles}.',
  },
});
