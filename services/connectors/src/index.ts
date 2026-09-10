import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { executeNative } from "../vendor/gogcli";
import { readInternalAuth } from "../../../src/utils/internalAuth";
import { ConnectorService, connectorObjectName } from "./core";

/** Private, explicitly named service-binding entrypoint. There is no public HTTP API. */
export class ConnectorEntrypoint extends WorkerEntrypoint<ConnectorEnv> {
  async fetch(request: Request): Promise<Response> {
    if ((this.env.CONNECTOR_AUTH_SECRET ?? "").length < 32)
      return Response.json(
        { error: "Connector configuration required" },
        { status: 503 },
      );
    const context = await readInternalAuth(request, {
      INTERNAL_AUTH_SECRET: this.env.CONNECTOR_AUTH_SECRET,
    });
    if (!context)
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (context.role !== "owner")
      return Response.json({ error: "Owner access required" }, { status: 403 });
    const object = this.env.CONNECTOR_VAULT.getByName(
      await connectorObjectName(context),
    );
    return object.fetch(request);
  }
}

export class ConnectorVault extends DurableObject<ConnectorEnv> {
  private service: ConnectorService;
  constructor(ctx: DurableObjectState, env: ConnectorEnv) {
    super(ctx, env);
    this.service = new ConnectorService(ctx.storage.sql, env, {
      fetch: (request) => fetch(request),
      native: (request) =>
        executeNative(request, (outbound) => fetch(outbound)),
      now: () => Date.now(),
    });
  }
  async fetch(request: Request): Promise<Response> {
    return this.service.fetch(request);
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
