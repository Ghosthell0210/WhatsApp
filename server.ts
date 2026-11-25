import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { BridgeStore } from './src/bridge/store';
import { BridgeCoordinator } from './src/bridge/coordinator';
import { attachConsoleInterface } from './src/bridge/consoleCli';
import { normalizePhoneToJid, validateTelegramConfigInput } from './src/bridge/logic';
import type { BridgeWsEvent } from './src/bridge/types';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const store = new BridgeStore();
  const coordinator = new BridgeCoordinator(store);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (event: BridgeWsEvent) => {
    const serialized = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  };

  coordinator.subscribe(broadcast);

  wss.on('connection', (ws) => {
    const initEvent: BridgeWsEvent = {
      type: 'state:sync',
      payload: coordinator.getPublicState(),
    };
    ws.send(JSON.stringify(initEvent));
  });

  // REST API Endpoints
  app.get('/api/state', (_req, res) => {
    res.json(coordinator.getPublicState());
  });

  app.post('/api/telegram/connect', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';

    const validation = validateTelegramConfigInput(token, chatId);
    if (!validation.valid) {
      res.status(400).json({
        ok: false,
        errors: validation.errors,
        message: 'Revisa el Token del Bot y el Chat ID de Telegram.',
      });
      return;
    }

    const tgState = await coordinator.telegram.connect(token, chatId);
    if (tgState.status === 'error') {
      res.status(400).json({
        ok: false,
        telegram: tgState,
        message: tgState.lastError || 'No se pudo autenticar con Telegram.',
      });
      return;
    }

    res.json({ ok: true, telegram: tgState });
  });

  app.post('/api/telegram/disconnect', async (_req, res) => {
    const tgState = await coordinator.telegram.disconnect(true);
    res.json({ ok: true, telegram: tgState });
  });

  app.post('/api/telegram/test', async (_req, res) => {
    const result = await coordinator.telegram.sendTestNotification();
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  app.post('/api/whatsapp/connect', async (_req, res) => {
    const waState = await coordinator.whatsapp.connect();
    res.json({ ok: true, whatsapp: waState });
  });

  app.post('/api/whatsapp/disconnect', async (req, res) => {
    const logout = Boolean(req.body?.logout);
    const waState = await coordinator.whatsapp.disconnect(logout);
    res.json({ ok: true, whatsapp: waState });
  });

  app.patch('/api/rules', (req, res) => {
    const body = req.body ?? {};
    const nextPartial: Record<string, unknown> = {};

    if (typeof body.onlyPrivateMessages === 'boolean') {
      nextPartial.onlyPrivateMessages = body.onlyPrivateMessages;
    }
    if (typeof body.ignoreStatusBroadcasts === 'boolean') {
      nextPartial.ignoreStatusBroadcasts = body.ignoreStatusBroadcasts;
    }
    if (typeof body.includePhoneHeader === 'boolean') {
      nextPartial.includePhoneHeader = body.includePhoneHeader;
    }
    if (typeof body.autoAcknowledge === 'boolean') {
      nextPartial.autoAcknowledge = body.autoAcknowledge;
    }
    if (typeof body.autoAckMessage === 'string') {
      nextPartial.autoAckMessage = body.autoAckMessage.slice(0, 400);
    }

    const updated = coordinator.updateRules(nextPartial);
    res.json({ ok: true, rules: updated });
  });

  app.post('/api/conversations/:jid/read', (req, res) => {
    const jid = decodeURIComponent(req.params.jid || '');
    const updated = coordinator.store.markConversationRead(jid);
    if (!updated) {
      res.status(404).json({ ok: false, message: 'Conversación no encontrada.' });
      return;
    }
    res.json({ ok: true, conversation: updated });
  });

  app.post('/api/messages/reply', async (req, res) => {
    const rawJid = typeof req.body?.jid === 'string' ? req.body.jid.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const origin = req.body?.origin === 'telegram' ? 'telegram' : 'web';

    const jid = normalizePhoneToJid(rawJid);
    if (!jid) {
      res.status(400).json({ ok: false, message: 'JID o número de teléfono inválido.' });
      return;
    }
    if (!text) {
      res.status(400).json({ ok: false, message: 'Escribe una respuesta antes de enviar.' });
      return;
    }

    const result = await coordinator.sendOutboundReply({
      jid,
      text: text.slice(0, 2000),
      origin,
    });
    res.json(result);
  });

  app.post('/api/test-pipeline/incoming', async (req, res) => {
    const isGroup = Boolean(req.body?.isGroup);
    const senderName = typeof req.body?.senderName === 'string' ? req.body.senderName.trim() : '';
    const phoneOrJid = typeof req.body?.phoneOrJid === 'string' ? req.body.phoneOrJid.trim() : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!text) {
      res.status(400).json({ ok: false, message: 'Escribe el contenido del mensaje de prueba.' });
      return;
    }

    let jid: string | null = null;
    if (isGroup) {
      const groupDigits = phoneOrJid.replace(/[^0-9]/g, '') || '1203630998877';
      jid = `${groupDigits}@g.us`;
    } else {
      jid = normalizePhoneToJid(phoneOrJid);
      if (!jid) {
        res.status(400).json({
          ok: false,
          message: 'Ingresa un número de teléfono válido con código de país (ej. +5491155559999).',
        });
        return;
      }
    }

    const result = await coordinator.handleIncomingWhatsApp({
      jid,
      senderName: senderName || (isGroup ? 'Grupo de prueba' : `+${jid.split('@')[0]}`),
      text: text.slice(0, 2000),
      mediaType: 'text',
      source: 'pipeline_test',
    });

    res.json({ ok: true, ...result, jid });
  });

  app.post('/api/conversations/clear-samples', (_req, res) => {
    const state = coordinator.clearSamples();
    res.json({ ok: true, state });
  });

  // Frontend middleware / static serving
  const distDir = path.resolve(process.cwd(), 'dist');
  const hasDistBuild = fs.existsSync(path.join(distDir, 'index.html'));
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd && hasDistBuild) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.get('/', (_req, res) => {
      res.json({
        ok: true,
        service: 'Puente WA-TG (Modo consola)',
        state: coordinator.getPublicState(),
      });
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Puente WA-TG] Servidor activo en http://0.0.0.0:${PORT}`);
    const consoleController = attachConsoleInterface({
      getPublicState: () => coordinator.getPublicState(),
      connectTelegram: (token, chatId) => coordinator.telegram.connect(token, chatId),
      disconnectTelegram: () => coordinator.telegram.disconnect(true),
      testTelegram: () => coordinator.telegram.sendTestNotification(),
      setTelegramChatId: (chatId) => {
        coordinator.telegram.setChatId(chatId);
      },
      onTelegramChatIdDetected: (listener) => coordinator.telegram.onChatIdDetected(listener),
      connectWhatsApp: () => coordinator.whatsapp.connect(),
      disconnectWhatsApp: (logout) => coordinator.whatsapp.disconnect(logout),
      updateRules: (partial) => coordinator.updateRules(partial),
      sendOutboundReply: (params) => coordinator.sendOutboundReply(params),
    });

    void coordinator.bootstrapFromEnv().then(() => {
      const wizardStarted = consoleController.startInitialWizardIfNeeded();
      if (!wizardStarted) {
        console.log('[Puente WA-TG] Consola lista. Escribe "help" para ver comandos o "setup" para reconfigurar.');
      }
    });
  });
}

startServer().catch((err) => {
  console.error('[Puente WA-TG] Error fatal al iniciar:', err);
  process.exit(1);
});
