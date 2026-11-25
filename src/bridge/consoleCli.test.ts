import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsoleSessionController,
  parseConsoleCommand,
  parseYesNoInput,
  renderQrToTerminal,
  type ConsoleBridgeAdapter,
} from './consoleCli';
import type { BridgePublicState, RoutingRules, TelegramPublicState } from './types';

function createMockAdapter(overrides?: {
  telegramConnected?: boolean;
  whatsappConnected?: boolean;
}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let chatIdListener: ((id: string) => void) | null = null;

  let tgState: TelegramPublicState = {
    status: overrides?.telegramConnected ? 'connected' : 'disconnected',
    hasToken: Boolean(overrides?.telegramConnected),
    tokenMasked: overrides?.telegramConnected ? '7123456••••1234' : '',
    botUsername: overrides?.telegramConnected ? 'TestBridgeBot' : null,
    chatId: overrides?.telegramConnected ? '518294012' : '',
    lastError: null,
    lastDetectedChatId: null,
  };

  let rules: RoutingRules = {
    onlyPrivateMessages: true,
    ignoreStatusBroadcasts: true,
    includePhoneHeader: true,
    autoAcknowledge: false,
    autoAckMessage: '',
  };

  const adapter: ConsoleBridgeAdapter = {
    getPublicState: (): BridgePublicState => ({
      whatsapp: {
        status: overrides?.whatsappConnected ? 'connected' : 'disconnected',
        qrDataUrl: null,
        connectedPhone: null,
        connectedName: null,
        lastError: null,
      },
      telegram: tgState,
      rules,
      conversations: [],
      auditLog: [],
      stats: {
        totalForwardedToTg: 0,
        totalRepliesToWa: 0,
        totalIgnoredNonPv: 0,
        activeConversations: 0,
      },
    }),
    connectTelegram: async (token, chatId) => {
      calls.push({ fn: 'connectTelegram', args: [token, chatId] });
      tgState = {
        ...tgState,
        status: 'connected',
        hasToken: true,
        botUsername: 'MiPuenteBot',
        chatId,
      };
      return tgState;
    },
    disconnectTelegram: async () => {
      calls.push({ fn: 'disconnectTelegram', args: [] });
      tgState = { ...tgState, status: 'disconnected', hasToken: false };
      return tgState;
    },
    testTelegram: async () => ({ ok: true }),
    setTelegramChatId: (chatId) => {
      calls.push({ fn: 'setTelegramChatId', args: [chatId] });
      tgState = { ...tgState, chatId };
    },
    onTelegramChatIdDetected: (listener) => {
      chatIdListener = listener;
      return () => {
        chatIdListener = null;
      };
    },
    connectWhatsApp: async () => {
      calls.push({ fn: 'connectWhatsApp', args: [] });
    },
    disconnectWhatsApp: async (logout) => {
      calls.push({ fn: 'disconnectWhatsApp', args: [logout] });
    },
    updateRules: (partial) => {
      calls.push({ fn: 'updateRules', args: [partial] });
      rules = { ...rules, ...partial };
      return rules;
    },
    sendOutboundReply: async (params) => {
      calls.push({ fn: 'sendOutboundReply', args: [params] });
      return { ok: true, detail: 'Enviado' };
    },
  };

  return {
    adapter,
    calls,
    triggerDetectedChatId: (id: string) => chatIdListener?.(id),
  };
}

test('parseYesNoInput handles Spanish/English affirmations, negatives, and empty defaults', () => {
  assert.equal(parseYesNoInput('', true), true);
  assert.equal(parseYesNoInput('', false), false);
  assert.equal(parseYesNoInput('si', false), true);
  assert.equal(parseYesNoInput('S', false), true);
  assert.equal(parseYesNoInput('no', true), false);
  assert.equal(parseYesNoInput('talvez', true), null);
});

test('ConsoleSessionController walks through interactive setup step-by-step', async () => {
  const logs: string[] = [];
  const { adapter, calls } = createMockAdapter();
  const controller = new ConsoleSessionController(adapter, (msg) => logs.push(msg));

  const started = controller.startInitialWizardIfNeeded();
  assert.equal(started, true);
  assert.equal(controller.getStep(), 'awaiting_token');

  // Invalid token keeps step on awaiting_token
  await controller.handleLine('token-malo');
  assert.equal(controller.getStep(), 'awaiting_token');

  // Valid token moves to step 2 (chat id)
  await controller.handleLine('7123456789:AAH_abcdefghijklmnopqrstuvwxyz123');
  assert.equal(controller.getStep(), 'awaiting_chat_id');

  // Valid chat ID connects Telegram and moves to step 3 (PV filter)
  await controller.handleLine('518294012');
  assert.equal(controller.getStep(), 'awaiting_pv_only');

  // Confirm PV only and confirm QR generation
  await controller.handleLine('s');
  assert.equal(controller.getStep(), 'awaiting_qr_confirm');

  await controller.handleLine('');
  assert.equal(controller.getStep(), 'idle');

  assert.equal(calls.some((c) => c.fn === 'connectTelegram'), true);
  assert.equal(calls.some((c) => c.fn === 'updateRules'), true);
  assert.equal(calls.some((c) => c.fn === 'connectWhatsApp'), true);
});

test('ConsoleSessionController supports auto-detecting Chat ID via /start', async () => {
  const logs: string[] = [];
  const { adapter, calls, triggerDetectedChatId } = createMockAdapter();
  const controller = new ConsoleSessionController(adapter, (msg) => logs.push(msg));

  controller.startWizard();
  await controller.handleLine('7123456789:AAH_abcdefghijklmnopqrstuvwxyz123');
  await controller.handleLine('detectar');
  assert.equal(controller.getStep(), 'awaiting_detected_chat_id');

  triggerDetectedChatId('998877665');
  assert.equal(controller.getStep(), 'awaiting_pv_only');
  assert.equal(calls.some((c) => c.fn === 'setTelegramChatId' && c.args[0] === '998877665'), true);
});

test('startInitialWizardIfNeeded skips wizard when Telegram is already configured via env', () => {
  const { adapter } = createMockAdapter({ telegramConnected: true });
  const controller = new ConsoleSessionController(adapter, () => {});
  assert.equal(controller.startInitialWizardIfNeeded(), false);
  assert.equal(controller.getStep(), 'idle');
});

test('parseConsoleCommand parses WhatsApp, Telegram, rules, setup, and reply commands', () => {
  assert.deepEqual(parseConsoleCommand('setup'), { type: 'setup' });
  assert.deepEqual(parseConsoleCommand('qr'), { type: 'wa_connect' });
  assert.deepEqual(parseConsoleCommand('wa logout'), { type: 'wa_disconnect', logout: true });
  assert.deepEqual(parseConsoleCommand('status'), { type: 'status' });
  assert.deepEqual(
    parseConsoleCommand('tg 7123456789:AAH_abcdefghijklmnopqrstuvwxyz123 518294012'),
    {
      type: 'tg_connect',
      token: '7123456789:AAH_abcdefghijklmnopqrstuvwxyz123',
      chatId: '518294012',
    },
  );
  assert.deepEqual(parseConsoleCommand('pv off'), { type: 'set_pv_only', value: false });
  assert.deepEqual(parseConsoleCommand('responder +5491155551234 Hola qué tal'), {
    type: 'reply',
    target: '+5491155551234',
    message: 'Hola qué tal',
  });
});

test('renderQrToTerminal produces printable ASCII QR matrix', async () => {
  const ascii = await renderQrToTerminal('2@mock-whatsapp-qr-payload');
  assert.ok(ascii.length > 50);
  assert.ok(ascii.includes('\n'));
});
