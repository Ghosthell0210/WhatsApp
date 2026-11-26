import fs from 'node:fs';
import path from 'node:path';
import { maskToken } from './logic';
import type { CredentialsSummary } from './types';

export interface StoredCredentials {
  telegramBotToken: string;
  telegramChatId: string;
  whatsappPairingPhone: string;
  keepAliveUrl: string;
  keepAliveIntervalSec: number;
  updatedAt: number | null;
}

const PRIMARY_CRED_FILE = path.resolve(process.cwd(), 'credenciales.json');
const ALT_CRED_FILE = path.resolve(process.cwd(), 'credentials.json');
const DATA_CRED_FILE = path.resolve(process.cwd(), 'data/credentials.json');
const LEGACY_TG_SESSION_FILE = path.resolve(process.cwd(), 'data/tg-session.json');

const DEFAULT_CREDENTIALS: StoredCredentials = {
  telegramBotToken: '',
  telegramChatId: '',
  whatsappPairingPhone: '',
  keepAliveUrl: '',
  keepAliveIntervalSec: 45,
  updatedAt: null,
};

function normalizeCredentials(raw: Partial<StoredCredentials> | null | undefined): StoredCredentials {
  const interval =
    typeof raw?.keepAliveIntervalSec === 'number' && Number.isFinite(raw.keepAliveIntervalSec)
      ? Math.max(15, Math.min(300, Math.round(raw.keepAliveIntervalSec)))
      : 45;

  return {
    telegramBotToken: typeof raw?.telegramBotToken === 'string' ? raw.telegramBotToken.trim() : '',
    telegramChatId: typeof raw?.telegramChatId === 'string' ? raw.telegramChatId.trim() : '',
    whatsappPairingPhone:
      typeof raw?.whatsappPairingPhone === 'string' ? raw.whatsappPairingPhone.trim() : '',
    keepAliveUrl: typeof raw?.keepAliveUrl === 'string' ? raw.keepAliveUrl.trim() : '',
    keepAliveIntervalSec: interval,
    updatedAt: typeof raw?.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
  };
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeAtomicSecure(filePath: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(tmp, filePath);
  } catch {
    // Ignore disk write failures in read-only environments
  }
}

export class CredentialsStore {
  private readonly primaryFile: string;
  private cached: StoredCredentials;

  constructor(primaryFile = PRIMARY_CRED_FILE) {
    this.primaryFile = primaryFile;
    this.cached = this.loadFromDisk();
  }

  private loadFromDisk(): StoredCredentials {
    const candidates = [this.primaryFile, ALT_CRED_FILE, DATA_CRED_FILE];
    let loaded: StoredCredentials = { ...DEFAULT_CREDENTIALS };

    for (const candidate of candidates) {
      const parsed = readJsonSafe<Partial<StoredCredentials>>(candidate);
      if (parsed && typeof parsed === 'object') {
        const normalized = normalizeCredentials(parsed);
        if (!loaded.telegramBotToken && normalized.telegramBotToken) {
          loaded.telegramBotToken = normalized.telegramBotToken;
        }
        if (!loaded.telegramChatId && normalized.telegramChatId) {
          loaded.telegramChatId = normalized.telegramChatId;
        }
        if (!loaded.whatsappPairingPhone && normalized.whatsappPairingPhone) {
          loaded.whatsappPairingPhone = normalized.whatsappPairingPhone;
        }
        if (!loaded.keepAliveUrl && normalized.keepAliveUrl) {
          loaded.keepAliveUrl = normalized.keepAliveUrl;
        }
        if (normalized.keepAliveIntervalSec !== 45 && loaded.keepAliveIntervalSec === 45) {
          loaded.keepAliveIntervalSec = normalized.keepAliveIntervalSec;
        }
        if (!loaded.updatedAt && normalized.updatedAt) {
          loaded.updatedAt = normalized.updatedAt;
        }
      }
    }

    // Migrate legacy Telegram session file if token/chatId missing
    const legacy = readJsonSafe<{ botToken?: unknown; chatId?: unknown }>(LEGACY_TG_SESSION_FILE);
    let migrated = false;
    if (legacy && typeof legacy === 'object') {
      if (!loaded.telegramBotToken && typeof legacy.botToken === 'string' && legacy.botToken.trim()) {
        loaded.telegramBotToken = legacy.botToken.trim();
        migrated = true;
      }
      if (!loaded.telegramChatId && typeof legacy.chatId === 'string' && legacy.chatId.trim()) {
        loaded.telegramChatId = legacy.chatId.trim();
        migrated = true;
      }
    }

    // Always ensure credenciales.json exists on disk so user can see/edit it anytime
    if (migrated || !fs.existsSync(this.primaryFile)) {
      if (loaded.telegramBotToken || loaded.telegramChatId || loaded.whatsappPairingPhone) {
        loaded.updatedAt = loaded.updatedAt ?? Date.now();
      }
      writeAtomicSecure(this.primaryFile, loaded);
    }

    if (
      (loaded.telegramBotToken || loaded.telegramChatId || loaded.whatsappPairingPhone) &&
      !fs.existsSync(DATA_CRED_FILE)
    ) {
      writeAtomicSecure(DATA_CRED_FILE, loaded);
    }

    return loaded;
  }

  get(): StoredCredentials {
    // Also re-check if user edited credenciales.json manually while server was stopped or running
    const onDisk = readJsonSafe<Partial<StoredCredentials>>(this.primaryFile);
    if (onDisk && typeof onDisk === 'object') {
      const normalized = normalizeCredentials(onDisk);
      if (
        normalized.telegramBotToken !== this.cached.telegramBotToken ||
        normalized.telegramChatId !== this.cached.telegramChatId ||
        normalized.whatsappPairingPhone !== this.cached.whatsappPairingPhone ||
        normalized.keepAliveUrl !== this.cached.keepAliveUrl ||
        normalized.keepAliveIntervalSec !== this.cached.keepAliveIntervalSec
      ) {
        this.cached = normalized;
      }
    }
    return { ...this.cached };
  }

  save(partial: Partial<StoredCredentials>): StoredCredentials {
    const next = normalizeCredentials({
      ...this.cached,
      ...partial,
      updatedAt: Date.now(),
    });
    this.cached = next;
    writeAtomicSecure(this.primaryFile, next);
    if (this.primaryFile === PRIMARY_CRED_FILE) {
      writeAtomicSecure(DATA_CRED_FILE, next);
    }

    // Keep legacy session file in sync for backward compatibility
    if (next.telegramBotToken) {
      writeAtomicSecure(LEGACY_TG_SESSION_FILE, {
        botToken: next.telegramBotToken,
        chatId: next.telegramChatId,
      });
    }
    return { ...this.cached };
  }

  clearTelegramCredentials(): StoredCredentials {
    const next = this.save({
      telegramBotToken: '',
      telegramChatId: '',
    });
    try {
      if (fs.existsSync(LEGACY_TG_SESSION_FILE)) {
        fs.rmSync(LEGACY_TG_SESSION_FILE, { force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
    return next;
  }

  clearAll(): StoredCredentials {
    this.cached = { ...DEFAULT_CREDENTIALS, updatedAt: Date.now() };
    writeAtomicSecure(this.primaryFile, this.cached);
    try {
      if (this.primaryFile === PRIMARY_CRED_FILE && fs.existsSync(DATA_CRED_FILE)) {
        fs.rmSync(DATA_CRED_FILE, { force: true });
      }
      if (fs.existsSync(LEGACY_TG_SESSION_FILE)) {
        fs.rmSync(LEGACY_TG_SESSION_FILE, { force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
    return { ...this.cached };
  }

  getSummary(): CredentialsSummary {
    const current = this.get();
    return {
      filePath: path.basename(this.primaryFile),
      hasTelegramToken: Boolean(current.telegramBotToken),
      telegramTokenMasked: maskToken(current.telegramBotToken),
      hasTelegramChatId: Boolean(current.telegramChatId),
      telegramChatId: current.telegramChatId,
      whatsappPairingPhone: current.whatsappPairingPhone,
      keepAliveUrl: current.keepAliveUrl,
      keepAliveIntervalSec: current.keepAliveIntervalSec,
      updatedAt: current.updatedAt,
    };
  }
}
