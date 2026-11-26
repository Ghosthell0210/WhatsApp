import 'dotenv/config';
import { execSync } from 'node:child_process';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { BridgeStore } from './src/bridge/store';
import { BridgeCoordinator } from './src/bridge/coordinator';
import { attachConsoleInterface } from './src/bridge/consoleCli';
import { cleanupTempMediaDir } from './src/bridge/whatsappManager';
import {
  normalizePhoneToJid,
  sanitizePairingPhoneNumber,
  validateTelegramConfigInput,
} from './src/bridge/logic';
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

  app.post('/api/whatsapp/connect', async (req, res) => {
    const rawPhone = typeof req.body?.pairingPhone === 'string' ? req.body.pairingPhone.trim() : '';
    if (rawPhone) {
      const cleanPhone = sanitizePairingPhoneNumber(rawPhone);
      if (!cleanPhone) {
        res.status(400).json({
          ok: false,
          message: 'Número inválido. Usa código de país sin + (ej. 5491155551234).',
        });
        return;
      }
      const waState = await coordinator.whatsapp.connect({ pairingPhone: cleanPhone });
      res.json({ ok: true, whatsapp: waState });
      return;
    }

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
    if (typeof body.paused === 'boolean') {
      nextPartial.paused = body.paused;
    }
    if (typeof body.reactionsEnabled === 'boolean') {
      nextPartial.reactionsEnabled = body.reactionsEnabled;
    }
    if (Array.isArray(body.blockedJids)) {
      const normalized = body.blockedJids
        .map((item: unknown) => (typeof item === 'string' ? normalizePhoneToJid(item) : null))
        .filter((jid: string | null): jid is string => Boolean(jid));
      nextPartial.blockedJids = [...new Set(normalized)];
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

  app.post('/api/conversations/:jid/archive', (req, res) => {
    const jid = decodeURIComponent(req.params.jid || '');
    const updated = coordinator.store.toggleArchive(jid);
    if (!updated) {
      res.status(404).json({ ok: false, message: 'Conversación no encontrada.' });
      return;
    }
    broadcast({ type: 'conversation:updated', payload: updated });
    res.json({ ok: true, conversation: updated });
  });

  app.post('/api/contacts/import-vcf', (req, res) => {
    const vcfText = typeof req.body?.vcfText === 'string' ? req.body.vcfText : '';
    if (!vcfText.trim()) {
      res.status(400).json({ ok: false, message: 'Contenido VCF vacío.' });
      return;
    }
    const count = coordinator.store.importVcf(vcfText);
    const nextState = coordinator.getPublicState();
    broadcast({ type: 'state:sync', payload: nextState });
    res.json({ ok: true, importedCount: count, state: nextState });
  });

  app.patch('/api/contacts/:jid/alias', (req, res) => {
    const jid = decodeURIComponent(req.params.jid || '');
    const alias = typeof req.body?.alias === 'string' ? req.body.alias : '';
    const updated = coordinator.store.setContactAlias(jid, alias);
    const nextState = coordinator.getPublicState();
    broadcast({ type: 'state:sync', payload: nextState });
    res.json({ ok: true, contact: updated, state: nextState });
  });

  app.delete('/api/contacts/:jid', (req, res) => {
    const jid = decodeURIComponent(req.params.jid || '');
    const removed = coordinator.store.forgetContact(jid);
    if (!removed) {
      res.status(404).json({ ok: false, message: 'Contacto no encontrado.' });
      return;
    }
    const nextState = coordinator.getPublicState();
    broadcast({ type: 'state:sync', payload: nextState });
    res.json({ ok: true, state: nextState });
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
  const isProd = process.env.NODE_ENV === 'production';
  const isConsoleOnly =
    process.argv.includes('--console') ||
    process.env.HEADLESS === 'true' ||
    Boolean(process.env.P_SERVER_UUID);

  const getNewestMtime = (dirPath: string): number => {
    if (!fs.existsSync(dirPath)) return 0;
    const st = fs.statSync(dirPath);
    if (!st.isDirectory()) return st.mtimeMs;
    let max = st.mtimeMs;
    for (const entry of fs.readdirSync(dirPath)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'data') continue;
      const full = path.join(dirPath, entry);
      const childMax = getNewestMtime(full);
      if (childMax > max) max = childMax;
    }
    return max;
  };

  let hasDistBuild = fs.existsSync(path.join(distDir, 'index.html'));
  if (isProd || isConsoleOnly) {
    const distMtime = hasDistBuild ? fs.statSync(path.join(distDir, 'index.html')).mtimeMs : 0;
    const srcMtime = Math.max(
      getNewestMtime(path.resolve(process.cwd(), 'src')),
      getNewestMtime(path.resolve(process.cwd(), 'index.html')),
    );
    if (!hasDistBuild || srcMtime > distMtime) {
      try {
        console.log('[Puente WA-TG] Compilando interfaz web actualizada (vite build)...');
        execSync('npx vite build', { stdio: 'inherit' });
        hasDistBuild = fs.existsSync(path.join(distDir, 'index.html'));
      } catch (err) {
        console.warn('[Puente WA-TG] Aviso: no se pudo compilar vite build automáticamente:', err);
      }
    }
  }

  if ((isProd || isConsoleOnly) && hasDistBuild) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else if (!isProd && !isConsoleOnly) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.get('*', (_req, res) => {
      res.json({
        ok: true,
        service: 'Puente WA-TG',
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
      connectWhatsApp: (options) => coordinator.whatsapp.connect(options),
      disconnectWhatsApp: (logout) => coordinator.whatsapp.disconnect(logout),
      hasSavedWhatsAppSession: () => coordinator.whatsapp.hasSavedSession(),
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

  const gracefulShutdown = (signal: string) => {
    console.log(`[Puente WA-TG] Señal ${signal} recibida, guardando historial en disco...`);
    store.flushToDisk();
    cleanupTempMediaDir();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[Puente WA-TG] Error fatal al iniciar:', err);
  process.exit(1);
});
