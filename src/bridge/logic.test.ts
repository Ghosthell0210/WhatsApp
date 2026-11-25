import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateWhatsAppJid,
  extractRawNumberFromJid,
  formatPhoneDisplay,
  normalizePhoneToJid,
  extractWhatsAppMessageText,
  formatTelegramForwardText,
  parseTelegramReplyCommand,
  validateTelegramConfigInput,
  maskToken,
} from './logic';
import type { RoutingRules } from './types';

const defaultRules: RoutingRules = {
  onlyPrivateMessages: true,
  ignoreStatusBroadcasts: true,
  includePhoneHeader: true,
  autoAcknowledge: false,
  autoAckMessage: '',
};

test('isPrivateWhatsAppJid allows private DMs and blocks groups/broadcasts when enabled', () => {
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

test('formatTelegramForwardText formats clear reply-ready message', () => {
  const formatted = formatTelegramForwardText({
    senderName: 'Lucía Méndez',
    phoneDisplay: '+5491155551234',
    text: '¿Seguimos con la reunión de hoy?',
    includePhoneHeader: true,
  });
  assert.ok(formatted.includes('WhatsApp PV · Lucía Méndez (+5491155551234)'));
  assert.ok(formatted.includes('¿Seguimos con la reunión de hoy?'));
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
