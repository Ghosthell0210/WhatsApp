import { Bot, InputFile } from 'grammy';
import {
  formatTelegramForwardText,
  formatTelegramHeader,
  formatTelegramMediaCaption,
  maskToken,
  normalizePhoneToJid,
  parseTelegramReplyCommand,
} from './logic';
import type { BridgeStore } from './store';
import type { TelegramPublicState, WhatsAppMediaPayload } from './types';

export interface TelegramReplyPayload {
  jid: string;
  text: string;
  telegramMessageId: number;
}

export type TelegramControlCommand =
  | { type: 'status' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'block'; targetJidOrPhone: string }
  | { type: 'unblock'; targetJidOrPhone: string }
  | { type: 'list_blocked' }
  | { type: 'help' };

export class TelegramManager {
  private bot: Bot | null = null;
  private activeToken = '';
  private store: BridgeStore;
  private onStateChange: (state: TelegramPublicState) => void;
  private onReplyReceived: (payload: TelegramReplyPayload) => Promise<{ ok: boolean; detail: string }>;
  private onPairingRequest?: (phone: string) => Promise<string>;
  private onControlCommand?: (cmd: TelegramControlCommand) => Promise<string>;
  private chatIdDetectedListeners = new Set<(chatId: string) => void>();

  constructor(params: {
    store: BridgeStore;
    onStateChange: (state: TelegramPublicState) => void;
    onReplyReceived: (payload: TelegramReplyPayload) => Promise<{ ok: boolean; detail: string }>;
    onPairingRequest?: (phone: string) => Promise<string>;
    onControlCommand?: (cmd: TelegramControlCommand) => Promise<string>;
  }) {
    this.store = params.store;
    this.onStateChange = params.onStateChange;
    this.onReplyReceived = params.onReplyReceived;
    this.onPairingRequest = params.onPairingRequest;
    this.onControlCommand = params.onControlCommand;
  }

  onChatIdDetected(listener: (chatId: string) => void): () => void {
    this.chatIdDetectedListeners.add(listener);
    return () => {
      this.chatIdDetectedListeners.delete(listener);
    };
  }

  setChatId(chatId: string): TelegramPublicState {
    const next = this.store.setTelegramState({ chatId: chatId.trim() });
    this.onStateChange(next);
    return next;
  }

  async connect(token: string, chatId: string): Promise<TelegramPublicState> {
    await this.disconnect(false);

    const trimmedToken = token.trim();
    const trimmedChatId = chatId.trim();

    const connectingState = this.store.setTelegramState({
      status: 'connecting',
      hasToken: Boolean(trimmedToken),
      tokenMasked: maskToken(trimmedToken),
      chatId: trimmedChatId,
      lastError: null,
    });
    this.onStateChange(connectingState);

    try {
      const bot = new Bot(trimmedToken);
      const me = await bot.api.getMe();

      bot.command(['start', 'id'], async (ctx) => {
        const detectedId = String(ctx.chat.id);
        const updated = this.store.setTelegramState({
          lastDetectedChatId: detectedId,
        });
        this.onStateChange(updated);

        for (const listener of this.chatIdDetectedListeners) {
          try {
            listener(detectedId);
          } catch {
            // Ignore listener errors
          }
        }

        await ctx.reply(
          `Puente WA-TG activo.\nTu Chat ID es: ${detectedId}\n\nCuando recibas un mensaje privado de WhatsApp aquí, simplemente usa "Responder" sobre ese mensaje para contestar por WhatsApp.`,
        );
      });

      bot.on('message:text', async (ctx) => {
        const incomingChatId = String(ctx.chat.id);
        const currentTargetChatId = this.store.getTelegramState().chatId;

        // Always record last detected chat ID for convenience
        if (incomingChatId !== this.store.getTelegramState().lastDetectedChatId) {
          this.onStateChange(this.store.setTelegramState({ lastDetectedChatId: incomingChatId }));
        }

        // Only accept outbound commands/replies from the authorized Chat ID
        if (currentTargetChatId && incomingChatId !== currentTargetChatId) {
          await ctx.reply('Este chat no está autorizado en Puente WA-TG.');
          return;
        }

        const text = ctx.message.text.trim();
        if (!text) return;

        // 0. Check /codigo or /vincular command to request WhatsApp pairing code straight from Telegram
        const pairMatch = text.match(/^\/(?:codigo|vincular)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
        if (pairMatch && this.onPairingRequest) {
          const rawPhone = (pairMatch[1] ?? '').trim();
          const replyText = await this.onPairingRequest(rawPhone);
          await ctx.reply(replyText, {
            reply_parameters: { message_id: ctx.message.message_id },
          });
          return;
        }

        // 0b. Check bridge administration commands (/estado, /pausar, /reanudar, /bloquear, /desbloquear, /bloqueados, /ayuda)
        if (this.onControlCommand) {
          const controlMatch = text.match(
            /^\/(estado|status|pausar|pause|reanudar|resume|bloquear|desbloquear|bloqueados|ayuda|help)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i,
          );
          if (controlMatch) {
            const cmdName = controlMatch[1].toLowerCase();
            const arg = (controlMatch[2] ?? '').trim();
            let ctrlRes: string | null = null;

            if (cmdName === 'estado' || cmdName === 'status') {
              ctrlRes = await this.onControlCommand({ type: 'status' });
            } else if (cmdName === 'pausar' || cmdName === 'pause') {
              ctrlRes = await this.onControlCommand({ type: 'pause' });
            } else if (cmdName === 'reanudar' || cmdName === 'resume') {
              ctrlRes = await this.onControlCommand({ type: 'resume' });
            } else if (cmdName === 'bloqueados') {
              ctrlRes = await this.onControlCommand({ type: 'list_blocked' });
            } else if (cmdName === 'ayuda' || cmdName === 'help') {
              ctrlRes = await this.onControlCommand({ type: 'help' });
            } else if (cmdName === 'bloquear') {
              let target = arg;
              if (!target && ctx.message.reply_to_message) {
                target =
                  this.store.lookupJidByTelegramMessageId(ctx.message.reply_to_message.message_id) ?? '';
              }
              ctrlRes = await this.onControlCommand({ type: 'block', targetJidOrPhone: target });
            } else if (cmdName === 'desbloquear') {
              ctrlRes = await this.onControlCommand({ type: 'unblock', targetJidOrPhone: arg });
            }

            if (ctrlRes !== null) {
              await ctx.reply(ctrlRes, {
                reply_parameters: { message_id: ctx.message.message_id },
              });
              return;
            }
          }
        }

        // 1. Check /reply or /responder command
        const cmd = parseTelegramReplyCommand(text);
        if (cmd) {
          const jid = normalizePhoneToJid(cmd.target);
          if (!jid) {
            await ctx.reply('Número o JID inválido. Ejemplo: /responder +5491155551234 Hola!');
            return;
          }
          const result = await this.onReplyReceived({
            jid,
            text: cmd.message,
            telegramMessageId: ctx.message.message_id,
          });
          await ctx.reply(result.detail, {
            reply_parameters: { message_id: ctx.message.message_id },
          });
          return;
        }

        // 2. Check native Telegram Reply-to-Message
        const replyTo = ctx.message.reply_to_message;
        if (replyTo) {
          let targetJid = this.store.lookupJidByTelegramMessageId(replyTo.message_id);

          // Fallback: parse phone from quoted bot header if bot was restarted
          if (!targetJid && 'text' in replyTo && typeof replyTo.text === 'string') {
            const match = replyTo.text.match(/\((\+?\d{7,16})\)/);
            if (match?.[1]) {
              targetJid = normalizePhoneToJid(match[1]);
            }
          }

          if (!targetJid) {
            await ctx.reply(
              'No pude identificar el contacto de WhatsApp para ese mensaje. Responde directamente a un mensaje reenviado por el puente o usa /responder <numero> <mensaje>.',
            );
            return;
          }

          const result = await this.onReplyReceived({
            jid: targetJid,
            text,
            telegramMessageId: ctx.message.message_id,
          });
          await ctx.reply(result.detail, {
            reply_parameters: { message_id: ctx.message.message_id },
          });
        }
      });

      bot.catch((err) => {
        console.error('[TelegramManager] Bot polling error:', err.error);
      });

      this.bot = bot;
      this.activeToken = trimmedToken;

      // Start long polling without awaiting forever
      void bot.start({
        drop_pending_updates: true,
      }).catch((err) => {
        const message = err instanceof Error ? err.message : 'Error en polling de Telegram';
        const next = this.store.setTelegramState({
          status: 'error',
          lastError: message,
        });
        this.onStateChange(next);
      });

      const connectedState = this.store.setTelegramState({
        status: 'connected',
        hasToken: true,
        tokenMasked: maskToken(trimmedToken),
        botUsername: me.username ?? me.first_name,
        chatId: trimmedChatId,
        lastError: null,
      });
      this.onStateChange(connectedState);
      return connectedState;
    } catch (err) {
      this.bot = null;
      this.activeToken = '';
      const errMsg = err instanceof Error ? err.message : 'No se pudo conectar con Telegram Bot API';
      const failedState = this.store.setTelegramState({
        status: 'error',
        botUsername: null,
        lastError: errMsg,
      });
      this.onStateChange(failedState);
      return failedState;
    }
  }

  async forwardPrivateMessage(params: {
    senderName: string;
    phoneDisplay: string;
    text: string;
    includePhoneHeader: boolean;
    media?: WhatsAppMediaPayload;
  }): Promise<{
    delivered: boolean;
    telegramMessageId?: number;
    extraTelegramMessageIds?: number[];
    error?: string;
  }> {
    const state = this.store.getTelegramState();
    if (!this.bot || state.status !== 'connected' || !state.chatId) {
      return { delivered: false, error: 'Telegram no conectado' };
    }

    if (params.media) {
      try {
        const media = params.media;
        const caption = formatTelegramMediaCaption({
          senderName: params.senderName,
          phoneDisplay: params.phoneDisplay,
          caption: media.caption,
          includePhoneHeader: params.includePhoneHeader,
        });
        const ext = media.mimeType?.split('/')[1]?.split(';')[0] || 'bin';
        const defaultName =
          media.fileName ||
          (media.kind === 'image'
            ? `imagen.${ext}`
            : media.kind === 'audio'
              ? media.ptt
                ? 'nota_de_voz.ogg'
                : `audio.${ext}`
              : media.kind === 'video'
                ? `video.${ext}`
                : media.kind === 'sticker'
                  ? 'sticker.webp'
                  : `archivo.${ext}`);
        const inputFile = new InputFile(media.buffer, defaultName);

        if (media.kind === 'image') {
          const sent = await this.bot.api.sendPhoto(state.chatId, inputFile, { caption });
          return { delivered: true, telegramMessageId: sent.message_id };
        }
        if (media.kind === 'audio') {
          const sent = media.ptt
            ? await this.bot.api.sendVoice(state.chatId, inputFile, { caption })
            : await this.bot.api.sendAudio(state.chatId, inputFile, { caption });
          return { delivered: true, telegramMessageId: sent.message_id };
        }
        if (media.kind === 'video') {
          const sent = await this.bot.api.sendVideo(state.chatId, inputFile, { caption });
          return { delivered: true, telegramMessageId: sent.message_id };
        }
        if (media.kind === 'sticker') {
          const stickerMsg = await this.bot.api.sendSticker(state.chatId, inputFile);
          const header = formatTelegramHeader(params);
          const headerMsg = await this.bot.api.sendMessage(
            state.chatId,
            `${header}\n\n[Sticker recibido] — Responde a este mensaje para contestar por WhatsApp.`,
            { reply_parameters: { message_id: stickerMsg.message_id } },
          );
          return {
            delivered: true,
            telegramMessageId: headerMsg.message_id,
            extraTelegramMessageIds: [stickerMsg.message_id],
          };
        }

        const sent = await this.bot.api.sendDocument(state.chatId, inputFile, { caption });
        return { delivered: true, telegramMessageId: sent.message_id };
      } catch {
        // Fallback to text forwarding if Telegram rejects specific media encoding
      }
    }

    try {
      const formatted = formatTelegramForwardText(params);
      const sent = await this.bot.api.sendMessage(state.chatId, formatted);
      return { delivered: true, telegramMessageId: sent.message_id };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Error al enviar a Telegram';
      return { delivered: false, error };
    }
  }

  async sendTestNotification(): Promise<{ ok: boolean; error?: string; telegramMessageId?: number }> {
    const state = this.store.getTelegramState();
    if (!this.bot || state.status !== 'connected' || !state.chatId) {
      return { ok: false, error: 'Conecta primero el Bot Token y el Chat ID de Telegram.' };
    }

    try {
      const sent = await this.bot.api.sendMessage(
        state.chatId,
        'Prueba de conexión exitosa desde Puente WA-TG. Los mensajes privados de WhatsApp llegarán aquí.',
      );
      return { ok: true, telegramMessageId: sent.message_id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Error al enviar mensaje de prueba',
      };
    }
  }

  async sendSystemNotice(text: string): Promise<boolean> {
    const state = this.store.getTelegramState();
    if (!this.bot || state.status !== 'connected' || !state.chatId) {
      return false;
    }
    try {
      await this.bot.api.sendMessage(state.chatId, text);
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(clearToken = true): Promise<TelegramPublicState> {
    if (this.bot) {
      try {
        await this.bot.stop();
      } catch {
        // Ignore stop errors
      }
      this.bot = null;
    }
    if (clearToken) {
      this.activeToken = '';
    }

    const next = this.store.setTelegramState({
      status: 'disconnected',
      ...(clearToken ? { hasToken: false, tokenMasked: '', botUsername: null } : {}),
      lastError: null,
    });
    this.onStateChange(next);
    return next;
  }

  isActive(): boolean {
    return Boolean(this.bot && this.activeToken && this.store.getTelegramState().status === 'connected');
  }
}
