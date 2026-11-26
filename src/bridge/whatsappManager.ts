import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import {
  extractMediaMetadata,
  extractWhatsAppMessageText,
  extractWhatsAppReaction,
  formatByteSize,
  formatPairingCode,
  formatPhoneDisplay,
  MAX_MEDIA_BYTES,
  MAX_TEMP_DISK_BYTES,
  sanitizePairingPhoneNumber,
} from './logic';
import type { BridgeStore } from './store';
import type {
  MediaKind,
  WhatsAppMediaPayload,
  WhatsAppMessageKeyRef,
  WhatsAppPublicState,
} from './types';

const AUTH_DIR = path.resolve(process.cwd(), 'data/wa-auth');
export const TMP_MEDIA_DIR = path.resolve(process.cwd(), 'data/tmp-media');

function getDirTotalBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) total += st.size;
    } catch {
      // Ignore files deleted concurrently
    }
  }
  return total;
}

export function cleanupTempMediaDir(): void {
  try {
    if (!fs.existsSync(TMP_MEDIA_DIR)) return;
    for (const name of fs.readdirSync(TMP_MEDIA_DIR)) {
      fs.rmSync(path.join(TMP_MEDIA_DIR, name), { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

export interface WhatsAppInboundPayload {
  jid: string;
  senderName: string;
  text: string;
  mediaType: MediaKind;
  media?: WhatsAppMediaPayload;
  whatsappMessageId?: string;
  whatsappKey?: WhatsAppMessageKeyRef;
}

export interface WhatsAppInboundReactionPayload {
  jid: string;
  senderJid: string;
  targetMessageId: string;
  emoji: string;
}

export interface WhatsAppConnectOptions {
  pairingPhone?: string;
}

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private manualDisconnect = false;
  private isConnecting = false;
  private pendingPairingPhone: string | null = null;
  private pairingCodeRequested = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private store: BridgeStore;
  private onStateChange: (state: WhatsAppPublicState) => void;
  private onIncomingMessage: (payload: WhatsAppInboundPayload) => Promise<void>;
  private onIncomingReaction?: (payload: WhatsAppInboundReactionPayload) => Promise<void>;
  private settleWaiters = new Set<() => void>();

  constructor(params: {
    store: BridgeStore;
    onStateChange: (state: WhatsAppPublicState) => void;
    onIncomingMessage: (payload: WhatsAppInboundPayload) => Promise<void>;
    onIncomingReaction?: (payload: WhatsAppInboundReactionPayload) => Promise<void>;
  }) {
    this.store = params.store;
    this.onStateChange = params.onStateChange;
    this.onIncomingMessage = params.onIncomingMessage;
    this.onIncomingReaction = params.onIncomingReaction;
    cleanupTempMediaDir();
  }

  private notifyState(state: WhatsAppPublicState): void {
    this.onStateChange(state);
    if (state.status !== 'connecting') {
      for (const resolve of this.settleWaiters) {
        resolve();
      }
      this.settleWaiters.clear();
    }
  }

  async waitUntilSettled(timeoutMs = 3500): Promise<void> {
    if (this.store.getWhatsAppState().status !== 'connecting') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.settleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.settleWaiters.add(done);
    });
  }

  hasSavedSession(): boolean {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as {
        registered?: boolean;
        account?: unknown;
      };
      return Boolean(parsed.registered || parsed.account);
    } catch {
      return false;
    }
  }

  private cleanupIncompleteAuthIfNeeded(): void {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    if (!this.hasSavedSession()) {
      this.wipeAuthDir();
    }
  }

  async connect(options?: WhatsAppConnectOptions): Promise<WhatsAppPublicState> {
    const requestedPhone = options?.pairingPhone
      ? sanitizePairingPhoneNumber(options.pairingPhone)
      : null;

    if (options?.pairingPhone && !requestedPhone) {
      const errState = this.store.setWhatsAppState({
        status: 'error',
        lastError: 'Número inválido. Usa código de país sin + (ej. 5491155551234).',
      });
      this.onStateChange(errState);
      return errState;
    }

    // If user switches pairing method while awaiting QR/code, reset unauthenticated socket cleanly
    if ((this.isConnecting || this.sock) && this.store.getWhatsAppState().status !== 'connected') {
      if (requestedPhone !== this.pendingPairingPhone) {
        await this.disconnect(false);
      } else {
        return this.store.getWhatsAppState();
      }
    }

    if (this.isConnecting || this.sock) {
      return this.store.getWhatsAppState();
    }

    this.manualDisconnect = false;
    this.isConnecting = true;
    this.pendingPairingPhone = requestedPhone;
    this.pairingCodeRequested = false;
    this.clearReconnectTimer();

    const connectingState = this.store.setWhatsAppState({
      status: 'connecting',
      qrDataUrl: null,
      pairingCode: null,
      lastError: null,
    });
    this.onStateChange(connectingState);

    try {
      this.cleanupIncompleteAuthIfNeeded();
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      let pairingConfirmed = Boolean(state.creds.account || state.creds.registered);
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
        browser: Browsers.ubuntu('Chrome'),
        qrTimeout: 90_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2_000,
        syncFullHistory: false,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
      });

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
        if (isNewLogin) {
          pairingConfirmed = true;
        }

        if (qr) {
          if (this.pendingPairingPhone && !state.creds.registered && !pairingConfirmed) {
            if (!this.pairingCodeRequested) {
              this.pairingCodeRequested = true;
              try {
                const rawCode = await sock.requestPairingCode(this.pendingPairingPhone);
                const formattedCode = formatPairingCode(rawCode);
                console.log('\n==================================================');
                console.log(` [WhatsApp] CÓDIGO DE VINCULACIÓN (sin QR): ${formattedCode}`);
                console.log('==================================================');
                console.log('En tu teléfono, toca la notificación de WhatsApp (o entra a');
                console.log('Dispositivos vinculados -> Vincular dispositivo -> Vincular con número de teléfono)');
                console.log('y escribe ese código en las 8 casillas.\n');
                const next = this.store.setWhatsAppState({
                  status: 'pairing_code_ready',
                  qrDataUrl: null,
                  pairingCode: formattedCode,
                  lastError: null,
                });
                this.notifyState(next);
              } catch (err) {
                const msg =
                  err instanceof Error
                    ? err.message
                    : 'No se pudo solicitar el código de vinculación.';
                this.wipeAuthDir();
                const next = this.store.setWhatsAppState({
                  status: 'error',
                  pairingCode: null,
                  lastError: msg,
                });
                this.notifyState(next);
              }
            }
          } else if (!this.pendingPairingPhone) {
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
                pairingCode: null,
                lastError: null,
              });
              this.notifyState(next);
            } catch {
              const next = this.store.setWhatsAppState({
                status: 'error',
                lastError: 'No se pudo generar la imagen del código QR.',
              });
              this.notifyState(next);
            }
          }
        }

        if (connection === 'open') {
          this.isConnecting = false;
          this.pendingPairingPhone = null;
          this.pairingCodeRequested = false;
          this.reconnectAttempts = 0;
          pairingConfirmed = true;
          const userJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
          const phone = userJid ? formatPhoneDisplay(userJid) : null;
          console.log(`[WhatsApp] Conectado correctamente (${phone || 'sesión activa'}).`);
          const next = this.store.setWhatsAppState({
            status: 'connected',
            qrDataUrl: null,
            pairingCode: null,
            connectedPhone: phone,
            connectedName: sock.user?.name || 'WhatsApp vinculado',
            lastError: null,
          });
          this.notifyState(next);
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

          // If pairing code expired before user entered it on phone, stop cleanly instead of silently changing code
          if (!this.manualDisconnect && this.pairingCodeRequested && !pairingConfirmed && !state.creds.registered) {
            this.wipeAuthDir();
            this.pendingPairingPhone = null;
            this.pairingCodeRequested = false;
            console.log('[WhatsApp] El código de 8 dígitos expiró antes de ingresarlo. Escribe "codigo <numero>" para pedir otro.');
            const next = this.store.setWhatsAppState({
              status: 'error',
              qrDataUrl: null,
              pairingCode: null,
              lastError: 'El código anterior expiró antes de confirmarse. Ingresa tu número otra vez para generar uno nuevo.',
            });
            this.notifyState(next);
            return;
          }

          if (!this.manualDisconnect && !isLoggedOut && statusCode !== DisconnectReason.badSession) {
            this.scheduleReconnect('Reconectando sesión de WhatsApp...');
          } else {
            this.pendingPairingPhone = null;
            this.pairingCodeRequested = false;
            const next = this.store.setWhatsAppState({
              status: 'disconnected',
              qrDataUrl: null,
              pairingCode: null,
              connectedPhone: null,
              connectedName: null,
              lastError: isLoggedOut
                ? 'La sesión se cerró desde el teléfono. Genera un nuevo código o QR para vincular.'
                : null,
            });
            this.notifyState(next);
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

          const messageObj = msg.message as Record<string, unknown> | null | undefined;
          const reactionInfo = extractWhatsAppReaction(messageObj);
          if (reactionInfo && this.onIncomingReaction) {
            await this.onIncomingReaction({
              jid: normalizedJid,
              senderJid: msg.key.participant || normalizedJid,
              targetMessageId: reactionInfo.targetMessageId,
              emoji: reactionInfo.emoji,
            });
            continue;
          }

          const extracted = extractWhatsAppMessageText(messageObj);
          if (!extracted.text) continue;

          let mediaPayload: WhatsAppMediaPayload | undefined;
          let finalText = extracted.text;
          const mediaMeta = extractMediaMetadata(messageObj);

          if (mediaMeta) {
            const activeTempBytes = getDirTotalBytes(TMP_MEDIA_DIR);
            if (mediaMeta.fileLength && mediaMeta.fileLength > MAX_MEDIA_BYTES) {
              finalText = `${extracted.text} (${formatByteSize(mediaMeta.fileLength)} · omitido por límite de 50 MB de Telegram)`;
            } else if (activeTempBytes + (mediaMeta.fileLength ?? 0) > MAX_TEMP_DISK_BYTES) {
              finalText = `${extracted.text} (omitido por límite temporal de disco)`;
            } else {
              const ext = (mediaMeta.mimeType?.split('/')[1]?.split(';')[0] || 'bin').replace(
                /[^a-zA-Z0-9]/g,
                '',
              ) || 'bin';
              fs.mkdirSync(TMP_MEDIA_DIR, { recursive: true });
              const tempFilePath = path.join(TMP_MEDIA_DIR, `${Date.now()}-${crypto.randomUUID()}.${ext}`);

              try {
                const byteLength = await this.streamMediaToTempFile(
                  msg,
                  sock,
                  tempFilePath,
                  activeTempBytes,
                );
                if (byteLength > 0) {
                  mediaPayload = {
                    kind: mediaMeta.kind,
                    tempFilePath,
                    mimeType: mediaMeta.mimeType,
                    fileName: mediaMeta.fileName,
                    ptt: mediaMeta.ptt,
                    caption: mediaMeta.caption,
                    byteLength,
                  };
                  finalText = `${extracted.text} (${formatByteSize(byteLength)})`;
                } else {
                  fs.rmSync(tempFilePath, { force: true });
                }
              } catch (err) {
                fs.rmSync(tempFilePath, { force: true });
                const reason = err instanceof Error ? err.message : '';
                if (reason === 'FILE_TOO_LARGE') {
                  finalText = `${extracted.text} (omitido por límite de 50 MB de Telegram)`;
                } else if (reason === 'TEMP_DISK_FULL') {
                  finalText = `${extracted.text} (omitido por límite temporal de disco)`;
                } else {
                  finalText = `${extracted.text} (no se pudo descargar el archivo)`;
                }
              }
            }
          }

          const senderName = msg.pushName?.trim() || '';
          const whatsappKey: WhatsAppMessageKeyRef | undefined = msg.key.id
            ? {
                remoteJid: normalizedJid,
                id: msg.key.id,
                fromMe: Boolean(msg.key.fromMe),
                participant: msg.key.participant || undefined,
              }
            : undefined;
          try {
            await this.onIncomingMessage({
              jid: normalizedJid,
              senderName,
              text: finalText,
              mediaType: extracted.mediaType,
              media: mediaPayload,
              whatsappMessageId: msg.key.id ?? undefined,
              whatsappKey,
            });
          } finally {
            if (mediaPayload?.tempFilePath) {
              fs.rmSync(mediaPayload.tempFilePath, { force: true });
            }
          }
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
        pairingCode: null,
        lastError: errMsg,
      });
      this.notifyState(next);
      if (!this.manualDisconnect && this.hasSavedSession()) {
        this.scheduleReconnect(`Reintentando conexión WhatsApp tras error: ${errMsg}`);
      }
      return next;
    }
  }

  private scheduleReconnect(reason: string): void {
    this.clearReconnectTimer();
    this.reconnectAttempts += 1;
    const delayMs = Math.min(30_000, 3_000 * Math.pow(2, Math.min(4, this.reconnectAttempts - 1)));
    const next = this.store.setWhatsAppState({
      status: 'connecting',
      qrDataUrl: null,
      pairingCode: null,
      lastError: reason,
    });
    this.notifyState(next);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualDisconnect) {
        void this.connect();
      }
    }, delayMs);
    if (typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  async ensureAwake(): Promise<boolean> {
    if (this.manualDisconnect) return false;
    if (!this.hasSavedSession()) return false;
    if (this.isConnecting || this.reconnectTimer) return true;

    const status = this.store.getWhatsAppState().status;
    if (status !== 'connected' || !this.sock) {
      console.log('[Keep-Alive] WhatsApp inactivo detectado con sesión guardada. Reconectando...');
      await this.connect();
      return false;
    }

    // Detect silently closed WebSocket on Baileys socket
    const wsObj = this.sock.ws as unknown as { isOpen?: boolean; readyState?: number } | undefined;
    if (wsObj && (wsObj.isOpen === false || (typeof wsObj.readyState === 'number' && wsObj.readyState > 1))) {
      console.log('[Keep-Alive] Socket de WhatsApp dormido/cerrado detectado. Reiniciando conexión...');
      await this.disconnect(false);
      this.manualDisconnect = false;
      await this.connect();
      return false;
    }

    return true;
  }

  private async streamMediaToTempFile(
    msg: WAMessage,
    sock: WASocket,
    tempFilePath: string,
    activeTempBytes: number,
  ): Promise<number> {
    const stream = await downloadMediaMessage(
      msg,
      'stream',
      {},
      {
        logger: pino({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage,
      },
    );

    return new Promise<number>((resolve, reject) => {
      let bytesWritten = 0;
      let settled = false;
      const writer = fs.createWriteStream(tempFilePath);

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        writer.destroy();
        fs.rmSync(tempFilePath, { force: true });
        reject(err);
      };

      stream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.byteLength;
        if (bytesWritten > MAX_MEDIA_BYTES) {
          fail(new Error('FILE_TOO_LARGE'));
          return;
        }
        if (activeTempBytes + bytesWritten > MAX_TEMP_DISK_BYTES) {
          fail(new Error('TEMP_DISK_FULL'));
          return;
        }
        if (!writer.write(chunk)) {
          stream.pause();
        }
      });

      writer.on('drain', () => {
        stream.resume();
      });

      stream.on('end', () => {
        writer.end();
      });

      writer.on('finish', () => {
        if (!settled) {
          settled = true;
          resolve(bytesWritten);
        }
      });

      stream.on('error', (err) => fail(err instanceof Error ? err : new Error('STREAM_ERROR')));
      writer.on('error', (err) => fail(err instanceof Error ? err : new Error('WRITE_ERROR')));
    });
  }

  async sendTextMessage(
    jid: string,
    text: string,
  ): Promise<{ sentOverNetwork: boolean; whatsappMessageId?: string; whatsappKey?: WhatsAppMessageKeyRef; error?: string }> {
    if (!this.sock || this.store.getWhatsAppState().status !== 'connected') {
      return { sentOverNetwork: false, error: 'WhatsApp no está conectado.' };
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text });
      const key = sent?.key?.id
        ? {
            remoteJid: jid,
            id: sent.key.id,
            fromMe: true,
          }
        : undefined;
      return { sentOverNetwork: true, whatsappMessageId: sent?.key?.id ?? undefined, whatsappKey: key };
    } catch (err) {
      return {
        sentOverNetwork: false,
        error: err instanceof Error ? err.message : 'Error al enviar texto a WhatsApp',
      };
    }
  }

  async sendMediaMessage(
    jid: string,
    media: WhatsAppMediaPayload,
  ): Promise<{ sentOverNetwork: boolean; whatsappMessageId?: string; whatsappKey?: WhatsAppMessageKeyRef; error?: string }> {
    if (!this.sock || this.store.getWhatsAppState().status !== 'connected') {
      return { sentOverNetwork: false, error: 'WhatsApp no está conectado.' };
    }
    try {
      const buffer = fs.readFileSync(media.tempFilePath);
      let sent;
      if (media.kind === 'image') {
        sent = await this.sock.sendMessage(jid, { image: buffer, caption: media.caption });
      } else if (media.kind === 'video') {
        sent = await this.sock.sendMessage(jid, { video: buffer, caption: media.caption });
      } else if (media.kind === 'audio') {
        sent = await this.sock.sendMessage(jid, {
          audio: buffer,
          ptt: media.ptt,
          mimetype: media.mimeType || 'audio/ogg; codecs=opus',
        });
      } else {
        sent = await this.sock.sendMessage(jid, {
          document: buffer,
          mimetype: media.mimeType || 'application/octet-stream',
          ...(media.fileName ? { fileName: media.fileName } : {}),
          caption: media.caption,
        });
      }
      const key = sent?.key?.id
        ? {
            remoteJid: jid,
            id: sent.key.id,
            fromMe: true,
          }
        : undefined;
      return { sentOverNetwork: true, whatsappMessageId: sent?.key?.id ?? undefined, whatsappKey: key };
    } catch (err) {
      return {
        sentOverNetwork: false,
        error: err instanceof Error ? err.message : 'Error al enviar archivo multimedia a WhatsApp',
      };
    }
  }

  async sendReactionMessage(
    jid: string,
    key: WhatsAppMessageKeyRef,
    emoji: string,
  ): Promise<{ sentOverNetwork: boolean; error?: string }> {
    if (!this.sock || this.store.getWhatsAppState().status !== 'connected') {
      return { sentOverNetwork: false, error: 'WhatsApp no está conectado.' };
    }
    try {
      await this.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: key.remoteJid,
            id: key.id,
            fromMe: Boolean(key.fromMe),
            ...(key.participant ? { participant: key.participant } : {}),
          },
        },
      });
      return { sentOverNetwork: true };
    } catch (err) {
      return {
        sentOverNetwork: false,
        error: err instanceof Error ? err.message : 'Error al enviar reacción a WhatsApp',
      };
    }
  }

  async disconnect(logout: boolean): Promise<WhatsAppPublicState> {
    this.manualDisconnect = true;
    this.isConnecting = false;
    this.pendingPairingPhone = null;
    this.pairingCodeRequested = false;
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
      pairingCode: null,
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
