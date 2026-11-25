import type { MediaKind, RoutingRules } from './types';

export interface JidCheckResult {
  allowed: boolean;
  reason?:
    | 'invalid_jid'
    | 'group_ignored'
    | 'broadcast_ignored'
    | 'newsletter_ignored'
    | 'unsupported_jid';
}

export function isPrivateWhatsAppJid(jid: string, rules: RoutingRules): JidCheckResult {
  if (!jid || typeof jid !== 'string') {
    return { allowed: false, reason: 'invalid_jid' };
  }

  const trimmed = jid.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'invalid_jid' };
  }

  if (trimmed === 'status@broadcast' || trimmed.endsWith('@broadcast')) {
    if (rules.ignoreStatusBroadcasts) {
      return { allowed: false, reason: 'broadcast_ignored' };
    }
    return { allowed: true };
  }

  if (trimmed.endsWith('@newsletter')) {
    return { allowed: false, reason: 'newsletter_ignored' };
  }

  if (trimmed.endsWith('@g.us')) {
    if (rules.onlyPrivateMessages) {
      return { allowed: false, reason: 'group_ignored' };
    }
    return { allowed: true };
  }

  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@lid')) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'unsupported_jid' };
}

export function extractRawNumberFromJid(jid: string): string {
  if (!jid) return '';
  const localPart = jid.split('@')[0] ?? '';
  const withoutDevice = localPart.split(':')[0] ?? '';
  return withoutDevice.replace(/[^0-9]/g, '');
}

export function formatPhoneDisplay(jid: string): string {
  const digits = extractRawNumberFromJid(jid);
  if (!digits) return jid;
  if (jid.endsWith('@lid')) {
    return `ID ${digits}`;
  }
  return `+${digits}`;
}

export function normalizePhoneToJid(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@lid')) {
    const digits = extractRawNumberFromJid(trimmed);
    if (digits.length >= 7 && digits.length <= 20) {
      return trimmed.endsWith('@lid')
        ? `${digits}@lid`
        : `${digits}@s.whatsapp.net`;
    }
    return null;
  }

  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 16) {
    return null;
  }
  return `${digits}@s.whatsapp.net`;
}

export interface ExtractedWhatsAppContent {
  text: string;
  mediaType: MediaKind;
}

export function extractWhatsAppMessageText(message: Record<string, unknown> | null | undefined): ExtractedWhatsAppContent {
  if (!message || typeof message !== 'object') {
    return { text: '', mediaType: 'text' };
  }

  // Unwrap ephemeral / viewOnce wrappers if present
  const ephemeral = message.ephemeralMessage as { message?: Record<string, unknown> } | undefined;
  if (ephemeral?.message) {
    return extractWhatsAppMessageText(ephemeral.message);
  }
  const viewOnce = message.viewOnceMessage as { message?: Record<string, unknown> } | undefined;
  if (viewOnce?.message) {
    return extractWhatsAppMessageText(viewOnce.message);
  }
  const viewOnceV2 = message.viewOnceMessageV2 as { message?: Record<string, unknown> } | undefined;
  if (viewOnceV2?.message) {
    return extractWhatsAppMessageText(viewOnceV2.message);
  }

  if (typeof message.conversation === 'string' && message.conversation.trim()) {
    return { text: message.conversation.trim(), mediaType: 'text' };
  }

  const extended = message.extendedTextMessage as { text?: string } | undefined;
  if (typeof extended?.text === 'string' && extended.text.trim()) {
    return { text: extended.text.trim(), mediaType: 'text' };
  }

  const image = message.imageMessage as { caption?: string } | undefined;
  if (image) {
    const caption = image.caption?.trim();
    return {
      text: caption ? `[Imagen] ${caption}` : '[Imagen recibida]',
      mediaType: 'image',
    };
  }

  const video = message.videoMessage as { caption?: string } | undefined;
  if (video) {
    const caption = video.caption?.trim();
    return {
      text: caption ? `[Video] ${caption}` : '[Video recibido]',
      mediaType: 'video',
    };
  }

  const audio = message.audioMessage as { ptt?: boolean } | undefined;
  if (audio) {
    return {
      text: audio.ptt ? '[Nota de voz]' : '[Archivo de audio]',
      mediaType: 'audio',
    };
  }

  const doc = message.documentMessage as { caption?: string; fileName?: string } | undefined;
  if (doc) {
    const label = doc.fileName ? `[Documento: ${doc.fileName}]` : '[Documento]';
    const caption = doc.caption?.trim();
    return {
      text: caption ? `${label} ${caption}` : label,
      mediaType: 'document',
    };
  }

  if (message.stickerMessage) {
    return { text: '[Sticker]', mediaType: 'sticker' };
  }

  const loc = message.locationMessage as { degreesLatitude?: number; degreesLongitude?: number } | undefined;
  if (loc) {
    const coords =
      typeof loc.degreesLatitude === 'number' && typeof loc.degreesLongitude === 'number'
        ? ` (${loc.degreesLatitude.toFixed(5)}, ${loc.degreesLongitude.toFixed(5)})`
        : '';
    return { text: `[Ubicación]${coords}`, mediaType: 'location' };
  }

  const contact = message.contactMessage as { displayName?: string } | undefined;
  if (contact) {
    return {
      text: contact.displayName ? `[Contacto: ${contact.displayName}]` : '[Contacto compartido]',
      mediaType: 'contact',
    };
  }

  const reaction = message.reactionMessage as { text?: string } | undefined;
  if (reaction) {
    return {
      text: reaction.text ? `[Reacción: ${reaction.text}]` : '[Reacción eliminada]',
      mediaType: 'reaction',
    };
  }

  return { text: '', mediaType: 'text' };
}

export function formatTelegramForwardText(params: {
  senderName: string;
  phoneDisplay: string;
  text: string;
  includePhoneHeader: boolean;
}): string {
  const safeName = params.senderName.trim() || params.phoneDisplay;
  const header = params.includePhoneHeader && safeName !== params.phoneDisplay
    ? `WhatsApp PV · ${safeName} (${params.phoneDisplay})`
    : `WhatsApp PV · ${safeName}`;

  return `${header}\n\n${params.text}\n\n— Responde a este mensaje para contestar por WhatsApp.`;
}

export interface ParsedReplyCommand {
  target: string;
  message: string;
}

export function parseTelegramReplyCommand(input: string): ParsedReplyCommand | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(?:reply|responder)(?:@[A-Za-z0-9_]+)?\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return null;

  const target = match[1]?.trim() ?? '';
  const message = match[2]?.trim() ?? '';
  if (!target || !message) return null;

  return { target, message };
}

export interface TelegramConfigValidation {
  valid: boolean;
  errors: {
    token?: string;
    chatId?: string;
  };
}

export function validateBotTokenFormat(token: string): string | undefined {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    return 'Ingresa el token del bot obtenido en @BotFather.';
  }
  if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(trimmedToken)) {
    return 'Formato inválido. Debe lucir como 123456789:AAH...';
  }
  return undefined;
}

export function validateChatIdFormat(chatId: string): string | undefined {
  const trimmedChatId = chatId.trim();
  if (!trimmedChatId) {
    return 'Ingresa tu Chat ID numérico de Telegram.';
  }
  if (!/^-?\d{4,20}$/.test(trimmedChatId)) {
    return 'El Chat ID debe ser un número entero (ej. 518294012 o -100...).';
  }
  return undefined;
}

export function validateTelegramConfigInput(token: string, chatId: string): TelegramConfigValidation {
  const errors: { token?: string; chatId?: string } = {};
  const tokenError = validateBotTokenFormat(token);
  const chatIdError = validateChatIdFormat(chatId);

  if (tokenError) errors.token = tokenError;
  if (chatIdError) errors.chatId = chatIdError;

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function maskToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 12) return '••••••••';
  return `${trimmed.slice(0, 7)}••••${trimmed.slice(-4)}`;
}
