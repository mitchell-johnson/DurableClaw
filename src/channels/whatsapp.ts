/**
 * WhatsApp Channel Integration via Baileys
 *
 * This module provides the architecture for WhatsApp connectivity
 * through the Baileys library running within the Durable Object's
 * V8 isolate via nodejs_compat.
 *
 * IMPORTANT: Baileys compatibility with Cloudflare Workers depends on
 * the nodejs_compat flag providing sufficient Node.js API coverage.
 * The crypto, buffer, stream, and events modules are required.
 *
 * Current status: Architecture defined, integration pending Baileys
 * runtime validation in Workers environment.
 */

import type { Env } from "../env";

export interface WhatsAppMessage {
  groupId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  messageId: string;
  isGroupMessage: boolean;
}

export interface WhatsAppConfig {
  /** R2 key prefix for storing auth state */
  authStatePrefix: string;
  /** Whether to auto-reconnect on disconnect */
  autoReconnect: boolean;
  /** Max reconnect attempts before giving up */
  maxReconnectAttempts: number;
}

const DEFAULT_CONFIG: WhatsAppConfig = {
  authStatePrefix: "whatsapp/auth/",
  autoReconnect: true,
  maxReconnectAttempts: 5,
};

/**
 * WhatsApp channel handler.
 *
 * Designed to run within a Durable Object, maintaining a persistent
 * WebSocket connection to WhatsApp's servers via the Baileys library.
 *
 * Auth credentials are persisted to R2 storage so the session survives
 * DO eviction and reactivation.
 */
export class WhatsAppChannel {
  private config: WhatsAppConfig;
  private connected = false;

  constructor(
    private env: Env,
    private onMessage: (msg: WhatsAppMessage) => Promise<void>,
    config?: Partial<WhatsAppConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Initialize the WhatsApp connection.
   *
   * This method will:
   * 1. Load auth state from R2 (if exists)
   * 2. Initialize the Baileys socket
   * 3. Handle QR code generation for first-time auth
   * 4. Persist auth state changes back to R2
   *
   * NOTE: This requires the Baileys library to be compatible with
   * the Workers runtime. If Baileys cannot run in Workers, this
   * module should be adapted to use an external WhatsApp gateway
   * service (e.g., a separate Node.js process or container that
   * bridges WhatsApp messages to the DO via HTTP/WebSocket).
   */
  async connect(): Promise<void> {
    // Architecture placeholder - Baileys integration
    //
    // The implementation would follow this pattern:
    //
    // 1. Load auth state from R2:
    //    const authState = await this.loadAuthState();
    //
    // 2. Create Baileys socket:
    //    const sock = makeWASocket({
    //      auth: authState,
    //      printQRInTerminal: false,
    //    });
    //
    // 3. Handle connection events:
    //    sock.ev.on('connection.update', ...)
    //    sock.ev.on('messages.upsert', ...)
    //    sock.ev.on('creds.update', ...)
    //
    // 4. On message received, call this.onMessage()
    //
    // For now, this is a no-op pending Baileys runtime validation.
    console.log("[WhatsApp] Channel architecture ready, awaiting Baileys integration");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    console.log("[WhatsApp] Disconnected");
  }

  /**
   * Send a text message to a WhatsApp group or contact.
   */
  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      throw new Error("WhatsApp not connected");
    }
    // Placeholder: sock.sendMessage(jid, { text })
    console.log(`[WhatsApp] Would send to ${jid}: ${text}`);
  }

  /**
   * Load Baileys auth state from R2 storage.
   */
  private async loadAuthState(): Promise<unknown> {
    const key = `${this.config.authStatePrefix}creds.json`;
    const obj = await this.env.WORKSPACE.get(key);
    if (!obj) return null;
    return obj.json();
  }

  /**
   * Save Baileys auth state to R2 storage.
   */
  private async saveAuthState(state: unknown): Promise<void> {
    const key = `${this.config.authStatePrefix}creds.json`;
    await this.env.WORKSPACE.put(key, JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}
