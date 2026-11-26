import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateWhatsAppJid,
  extractRawNumberFromJid,
  formatPhoneDisplay,
  normalizePhoneToJid,
  extractWhatsAppMessageText,
  extractMediaMetadata,
  formatByteSize,
  formatTelegramForwardText,
  formatTelegramMediaCaption,
  parseTelegramReplyCommand,
  validateTelegramConfigInput,
  maskToken,
  sanitizePairingPhoneNumber,
  formatPairingCode,
  MAX_MEDIA_BYTES,
  TELEGRAM_PHOTO_MAX_BYTES,
  MAX_TEMP_DISK_BYTES,
} from './logic';
import type { RoutingRules } from './types';

const defaultRules: RoutingRules = {
  onlyPrivateMessages: true,
  ignoreStatusBroadcasts: true,
  includePhoneHeader: true,
  autoAcknowledge: false,
  autoAckMessage: '',
  paused: false,
  blockedJids: [],
  reactionsEnabled: true,
};

test('isPrivateWhatsAppJid allows private DMs and blocks groups/broadcasts/blocked contacts when enabled', () => {
  assert.deepEqual(isPrivateWhatsAppJid('5491155551234@s.whatsapp.net', defaultRules), {
    allowed: true,
  });
  assert.deepEqual(isPrivateWhatsAppJid('981273918273@lid', defaultRules), {
    allowed: true,
  });
  assert.deepEqual(isPrivateWhatsAppJid('1203630491823@g.us', defaultRules), {
    allowed: false,
    reason: 'group_ignored',
  });
  assert.deepEqual(isPrivateWhatsAppJid('status@broadcast', defaultRules), {
    allowed: false,
    reason: 'broadcast_ignored',
  });
  assert.deepEqual(isPrivateWhatsAppJid('123456@newsletter', defaultRules), {
    allowed: false,
    reason: 'newsletter_ignored',
  });

  const withBlocked: RoutingRules = {
    ...defaultRules,
    blockedJids: ['5491155551234@s.whatsapp.net'],
  };
  assert.deepEqual(isPrivateWhatsAppJid('5491155551234@s.whatsapp.net', withBlocked), {
    allowed: false,
    reason: 'blocked_contact',
  });
});

test('isPrivateWhatsAppJid allows groups if onlyPrivateMessages is false', () => {
  const relaxedRules: RoutingRules = { ...defaultRules, onlyPrivateMessages: false };
  assert.deepEqual(isPrivateWhatsAppJid('1203630491823@g.us', relaxedRules), {
    allowed: true,
  });
});

test('extractRawNumberFromJid and formatPhoneDisplay strip device suffixes', () => {
  assert.equal(extractRawNumberFromJid('5491155551234:14@s.whatsapp.net'), '5491155551234');
  assert.equal(formatPhoneDisplay('5491155551234:14@s.whatsapp.net'), '+5491155551234');
  assert.equal(formatPhoneDisplay('987654321@lid'), 'ID 987654321');
});

test('normalizePhoneToJid converts phone numbers and preserves valid JIDs', () => {
  assert.equal(normalizePhoneToJid('+54 911 5555-1234'), '5491155551234@s.whatsapp.net');
  assert.equal(normalizePhoneToJid('5215512345678@s.whatsapp.net'), '5215512345678@s.whatsapp.net');
  assert.equal(normalizePhoneToJid('123'), null);
});

test('extractWhatsAppMessageText handles text, captions, voice notes, and wrapped messages', () => {
  assert.deepEqual(extractWhatsAppMessageText({ conversation: '  Hola mundo  ' }), {
    text: 'Hola mundo',
    mediaType: 'text',
  });
  assert.deepEqual(
    extractWhatsAppMessageText({
      ephemeralMessage: {
        message: { extendedTextMessage: { text: 'Mensaje temporal' } },
      },
    }),
    { text: 'Mensaje temporal', mediaType: 'text' },
  );
  assert.deepEqual(extractWhatsAppMessageText({ imageMessage: { caption: 'Foto del pedido' } }), {
    text: '[Imagen] Foto del pedido',
    mediaType: 'image',
  });
  assert.deepEqual(extractWhatsAppMessageText({ audioMessage: { ptt: true } }), {
    text: '[Nota de voz]',
    mediaType: 'audio',
  });
});

test('extractMediaMetadata and formatByteSize inspect media messages accurately', () => {
  const meta = extractMediaMetadata({
    viewOnceMessageV2: {
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'factura.pdf',
          caption: 'Adjunto factura',
          fileLength: '1572864',
        },
      },
    },
  });
  assert.deepEqual(meta, {
    kind: 'document',
    mimeType: 'application/pdf',
    fileName: 'factura.pdf',
    caption: 'Adjunto factura',
    fileLength: 1572864,
  });
  assert.equal(formatByteSize(1572864), '1.5 MB');
  assert.equal(formatByteSize(420_000), '410 KB');
  assert.equal(MAX_MEDIA_BYTES, 50 * 1024 * 1024);
  assert.equal(TELEGRAM_PHOTO_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_TEMP_DISK_BYTES, 350 * 1024 * 1024);
});

test('formatTelegramForwardText and formatTelegramMediaCaption format bounded captions', () => {
  const formatted = formatTelegramForwardText({
    senderName: 'Lucía Méndez',
    phoneDisplay: '+5491155551234',
    text: '¿Seguimos con la reunión de hoy?',
    includePhoneHeader: true,
  });
  assert.ok(formatted.includes('WhatsApp PV · Lucía Méndez (+5491155551234)'));
  assert.ok(formatted.includes('¿Seguimos con la reunión de hoy?'));

  const longCaption = formatTelegramMediaCaption({
    senderName: 'Lucía Méndez',
    phoneDisplay: '+5491155551234',
    caption: 'x'.repeat(1200),
    includePhoneHeader: true,
  });
  assert.ok(longCaption.length <= 1024);
});

test('parseTelegramReplyCommand parses /reply and /responder commands', () => {
  assert.deepEqual(parseTelegramReplyCommand('/responder +5491155551234 Hola, ya te llamo'), {
    target: '+5491155551234',
    message: 'Hola, ya te llamo',
  });
  assert.deepEqual(parseTelegramReplyCommand('/reply@PuenteBot 5215512345678 Listo!'), {
    target: '5215512345678',
    message: 'Listo!',
  });
  assert.equal(parseTelegramReplyCommand('Mensaje normal sin comando'), null);
});

test('validateTelegramConfigInput validates bot token and chat ID formats', () => {
  const invalid = validateTelegramConfigInput('bad-token', 'abc');
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.token);
  assert.ok(invalid.errors.chatId);

  const valid = validateTelegramConfigInput('7123456789:AAH_abcdefghijklmnopqrstuvwxyz123', '518294012');
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, {});
});

test('maskToken hides middle secret characters', () => {
  assert.equal(maskToken('7123456789:AAH_secret_value_12345'), '7123456••••2345');
  assert.equal(maskToken(''), '');
});

test('sanitizePairingPhoneNumber and formatPairingCode normalize phone digits and 8-char codes', () => {
  assert.equal(sanitizePairingPhoneNumber('+54 9 11 5555-1234'), '5491155551234');
  assert.equal(sanitizePairingPhoneNumber('12345'), null);
  assert.equal(formatPairingCode('ab12cd34'), 'AB12-CD34');
});

