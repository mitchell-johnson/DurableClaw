export type SignalSalience = "high" | "medium" | "low";
export interface Signal {
  kind: string;
  salience: SignalSalience;
  entity_type: string;
  entity_id: string;
  summary: string;
  occurred_at: number;
  dedupe_key: string;
}
export interface ObserverDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{
        results?: T[];
      }>;
    };
  };
}
export interface ObserverUser {
  id: string;
  role: string;
  permissions?: import("../../types/auth").UserPermission[];
}
export interface ObserverContext {
  workspaceId: string;
  db: ObserverDb;
  securedDb: ObserverDb;
  user: ObserverUser;
  readCursor(observerName: string): Promise<string | null>;
  writeCursor(observerName: string, cursorValue: string): Promise<void>;
  nowMs: number;
  reportError?: (source: string) => void;
  initialObservationTime?: (sourceKey: string) => number;
}
export interface Observer {
  name: string;
  observe(ctx: ObserverContext): Promise<Signal[]>;
}
