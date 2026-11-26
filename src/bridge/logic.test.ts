import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPrivateWhatsAppJid,
  extractRawNumberFromJid,
  formatPhoneDisplay,
  normalizePhoneToJid,
  extractWhatsAppMessageText,
  extractMediaMetadata,
  extractWhatsAppReaction,
  formatByteSize,
  formatReactionsSummary,
  formatTelegramForwardText,
  formatTelegramMediaCaption,
  formatTelegramMessageHtml,
  parseTelegramReplyCommand,
  parseVcfContacts,
  parseAuthorizedChatIds,
  getPrimaryChatId,
  isTelegramChatAuthorized,
  validateChatIdFormat,
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
  keepAliveEnabled: true,
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

test('parseVcfContacts extracts names and normalizes phone numbers', () => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN;CHARSET=UTF-8:Carlos Ruiz',
    'TEL;TYPE=CELL:+53 5 694-2234',
    'END:VCARD',
    'BEGIN:VCARD',
    'N:Gómez;Ana;;;',
    'TEL:+54 9 11 4444-5555',
    'END:VCARD',
  ].join('\n');

  const parsed = parseVcfContacts(vcf);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    fullName: 'Carlos Ruiz',
    phone: '+5356942234',
    jid: '5356942234@s.whatsapp.net',
  });
  assert.deepEqual(parsed[1], {
    fullName: 'Ana Gómez',
    phone: '+5491144445555',
    jid: '5491144445555@s.whatsapp.net',
  });
});

test('formatTelegramMessageHtml renders media badge, missing profile notice, and reaction counter', () => {
  const html = formatTelegramMessageHtml({
    senderName: '+5491155551234',
    phoneDisplay: '+5491155551234',
    text: 'Hola <mundo>',
    mediaType: 'image',
    includePhoneHeader: true,
    hasProfileName: false,
    hasCustomAlias: false,
    reactions: [
      { emoji: '❤️', count: 3, senders: ['a', 'b', 'c'] },
      { emoji: '👍', count: 1, senders: ['d'] },
    ],
    lastReactionNotice: 'reacción ❤️ puesta',
  });
  assert.ok(html.includes('<b>📷 Foto · +5491155551234</b>'));
  assert.ok(html.includes('Sin nombre de perfil'));
  assert.ok(html.includes('Hola &lt;mundo&gt;'));
  assert.ok(html.includes('❤️ x3 · 👍'));
  assert.equal(formatReactionsSummary([{ emoji: '🔥', count: 2, senders: ['a', 'b'] }]), '🔥 x2');
});

test('extractWhatsAppReaction extracts reaction target id and emoji or removal', () => {
  assert.deepEqual(
    extractWhatsAppReaction({
      reactionMessage: { key: { id: 'MSG123', fromMe: false }, text: '❤️' },
    }),
    { targetMessageId: 'MSG123', emoji: '❤️', fromMe: false },
  );
  assert.deepEqual(
    extractWhatsAppReaction({
      reactionMessage: { key: { id: 'MSG123', fromMe: false }, text: '' },
    }),
    { targetMessageId: 'MSG123', emoji: '', fromMe: false },
  );
});

test('CredentialsStore saves, reloads, masks, and clears credentials in a dedicated file', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { CredentialsStore } = await import('./credentials');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tg-creds-'));
  const credFile = path.join(tmpDir, 'credenciales.json');

  try {
    const store1 = new CredentialsStore(credFile);
    assert.equal(fs.existsSync(credFile), true);
    store1.save({
      telegramBotToken: '7123456789:AAH_secret_value_12345',
      telegramChatId: '518294012',
      whatsappPairingPhone: '5491155551234',
      keepAliveUrl: 'https://mi-bot.example.com/health',
      keepAliveIntervalSec: 30,
    });

    assert.equal(fs.existsSync(credFile), true);
    const store2 = new CredentialsStore(credFile);
    const loaded = store2.get();
    assert.equal(loaded.telegramBotToken, '7123456789:AAH_secret_value_12345');
    assert.equal(loaded.telegramChatId, '518294012');
    assert.equal(loaded.whatsappPairingPhone, '5491155551234');
    assert.equal(loaded.keepAliveUrl, 'https://mi-bot.example.com/health');
    assert.equal(loaded.keepAliveIntervalSec, 30);

    const summary = store2.getSummary();
    assert.equal(summary.hasTelegramToken, true);
    assert.equal(summary.telegramTokenMasked, '7123456••••2345');

    store2.clearAll();
    assert.equal(store2.get().telegramBotToken, '');
    assert.equal(store2.get().whatsappPairingPhone, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseAuthorizedChatIds, getPrimaryChatId, and isTelegramChatAuthorized support single and multiple Chat IDs', () => {
  assert.deepEqual(parseAuthorizedChatIds('1981484200, -1001234567890, 1981484200'), [
    '1981484200',
    '-1001234567890',
  ]);
  assert.equal(getPrimaryChatId('1981484200, -1001234567890'), '1981484200');
  assert.equal(isTelegramChatAuthorized('1981484200', '1981484200, -1001234567890'), true);
  assert.equal(isTelegramChatAuthorized('-1001234567890', '1981484200, -1001234567890'), true);
  assert.equal(isTelegramChatAuthorized('999888777', '1981484200, -1001234567890'), false);
  assert.equal(isTelegramChatAuthorized('999888777', ''), true);
  assert.equal(validateChatIdFormat('1981484200, -1001234567890'), undefined);
  assert.ok(validateChatIdFormat('1981484200, invalido'));
});




