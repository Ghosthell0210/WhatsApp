import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { extractWhatsAppMessageText, formatPhoneDisplay } from './logic';
import type { BridgeStore } from './store';
import type { MediaKind, WhatsAppPublicState } from './types';

const AUTH_DIR = path.resolve(process.cwd(), 'data/wa-auth');

export interface WhatsAppInboundPayload {
  jid: string;
  senderName: string;
  text: string;
  mediaType: MediaKind;
}

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private manualDisconnect = false;
  private isConnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private store: BridgeStore;
  private onStateChange: (state: WhatsAppPublicState) => void;
  private onIncomingMessage: (payload: WhatsAppInboundPayload) => Promise<void>;

  constructor(params: {
    store: BridgeStore;
    onStateChange: (state: WhatsAppPublicState) => void;
    onIncomingMessage: (payload: WhatsAppInboundPayload) => Promise<void>;
  }) {
    this.store = params.store;
    this.onStateChange = params.onStateChange;
    this.onIncomingMessage = params.onIncomingMessage;
  }

  hasSavedSession(): boolean {
    return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
  }

  async connect(): Promise<WhatsAppPublicState> {
    if (this.isConnecting || this.sock) {
      return this.store.getWhatsAppState();
    }

    this.manualDisconnect = false;
    this.isConnecting = true;
    this.clearReconnectTimer();

    const connectingState = this.store.setWhatsAppState({
      status: 'connecting',
      qrDataUrl: null,
      lastError: null,
    });
    this.onStateChange(connectingState);

    try {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      let version: [number, number, number] | undefined;
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
      } catch {
        // Fallback to Baileys bundled default version if version lookup is offline
      }

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
      });

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const [qrDataUrl, qrTerminal] = await Promise.all([
              QRCode.toDataURL(qr, {
                width: 280,
                margin: 2,
                color: { dark: '#0f172a', light: '#ffffff' },
              }),
              QRCode.toString(qr, { type: 'terminal', small: true }),
            ]);
            console.log('\n[WhatsApp] Escanea este código QR desde WhatsApp -> Dispositivos vinculados:');
            console.log(qrTerminal);
            const next = this.store.setWhatsAppState({
              status: 'qr_ready',
              qrDataUrl,
              lastError: null,
            });
            this.onStateChange(next);
          } catch {
            const next = this.store.setWhatsAppState({
              status: 'error',
              lastError: 'No se pudo generar la imagen del código QR.',
            });
            this.onStateChange(next);
          }
        }

        if (connection === 'open') {
          this.isConnecting = false;
          const userJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
          const phone = userJid ? formatPhoneDisplay(userJid) : null;
          console.log(`[WhatsApp] Conectado correctamente (${phone || 'sesión activa'}).`);
          const next = this.store.setWhatsAppState({
            status: 'connected',
            qrDataUrl: null,
            connectedPhone: phone,
            connectedName: sock.user?.name || 'WhatsApp vinculado',
            lastError: null,
          });
          this.onStateChange(next);
        }

        if (connection === 'close') {
          this.isConnecting = false;
          this.sock = null;
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
            ?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          if (isLoggedOut) {
            this.wipeAuthDir();
          }

          if (!this.manualDisconnect && !isLoggedOut && statusCode !== DisconnectReason.badSession) {
            const next = this.store.setWhatsAppState({
              status: 'connecting',
              qrDataUrl: null,
              lastError: 'Reconectando sesión de WhatsApp...',
            });
            this.onStateChange(next);
            this.reconnectTimer = setTimeout(() => {
              void this.connect();
            }, 3500);
          } else {
            const next = this.store.setWhatsAppState({
              status: 'disconnected',
              qrDataUrl: null,
              connectedPhone: null,
              connectedName: null,
              lastError: isLoggedOut
                ? 'La sesión se cerró desde el teléfono. Genera un nuevo QR para vincular.'
                : null,
            });
            this.onStateChange(next);
          }
        }
      });

      sock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return;
        for (const msg of event.messages) {
          if (!msg.key || msg.key.fromMe) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid) continue;
          const normalizedJid = rawJid.endsWith('@s.whatsapp.net') ? jidNormalizedUser(rawJid) : rawJid;

          const extracted = extractWhatsAppMessageText(msg.message as Record<string, unknown> | null | undefined);
          if (!extracted.text) continue;

          const senderName = msg.pushName?.trim() || formatPhoneDisplay(normalizedJid);
          await this.onIncomingMessage({
            jid: normalizedJid,
            senderName,
            text: extracted.text,
            mediaType: extracted.mediaType,
          });
        }
      });

      return this.store.getWhatsAppState();
    } catch (err) {
      this.isConnecting = false;
      this.sock = null;
      const errMsg = err instanceof Error ? err.message : 'Error al iniciar cliente de WhatsApp';
      const next = this.store.setWhatsAppState({
        status: 'error',
        qrDataUrl: null,
        lastError: errMsg,
      });
      this.onStateChange(next);
      return next;
    }
  }

  async sendTextMessage(jid: string, text: string): Promise<{ sentOverNetwork: boolean }> {
    if (!this.sock || this.store.getWhatsAppState().status !== 'connected') {
      return { sentOverNetwork: false };
    }
    await this.sock.sendMessage(jid, { text });
    return { sentOverNetwork: true };
  }

  async disconnect(logout: boolean): Promise<WhatsAppPublicState> {
    this.manualDisconnect = true;
    this.isConnecting = false;
    this.clearReconnectTimer();

    if (this.sock) {
      try {
        if (logout) {
          await this.sock.logout();
        } else {
          this.sock.end(undefined);
        }
      } catch {
        // Ignore socket teardown errors
      }
      this.sock = null;
    }

    if (logout) {
      this.wipeAuthDir();
    }

    const next = this.store.setWhatsAppState({
      status: 'disconnected',
      qrDataUrl: null,
      connectedPhone: null,
      connectedName: null,
      lastError: null,
    });
    this.onStateChange(next);
    return next;
  }

  private wipeAuthDir(): void {
    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
