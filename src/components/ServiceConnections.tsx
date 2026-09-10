import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../hooks/api";

interface ServiceConnection {
  id: string;
  provider: string;
  account: string;
  status: "connected" | "reauth_required";
  created_at: number;
  services: string[];
}
interface GoogleService {
  id: string;
  label: string;
  description?: string;
  scopes: string[];
  requires_workspace?: boolean;
  available?: boolean;
  authorization?: string;
}
interface ServicePage {
  configured: boolean;
  plugins: { id: string; label: string; description: string }[];
  services: GoogleService[];
  connections: ServiceConnection[];
}
interface OAuthFlow {
  popup: Window;
  state: string | null;
  deadline: number;
  handling: boolean;
  popupClosed: boolean;
  timer: ReturnType<typeof setInterval> | null;
}
const connectError =
  "Google Workspace could not be connected. Please try again.";
const expiredError =
  "The Google Workspace connection request expired. Please try again.";

function closePopup(flow: OAuthFlow) {
  if (flow.timer !== null) clearInterval(flow.timer);
  flow.timer = null;
  if (!flow.popupClosed) {
    flow.popupClosed = true;
    flow.popup.close();
  }
}

export function ServiceConnections({ api }: { api: Api }) {
  const [page, setPage] = useState<ServicePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedServices, setSelectedServices] = useState<string[]>(["gmail"]);
  const revision = useRef(0);
  const currentFlow = useRef<OAuthFlow | null>(null);
  const load = useCallback(async () => {
    const version = ++revision.current;
    setLoading(true);
    setError("");
    try {
      const result: ServicePage = await api("/api/connectors");
      if (revision.current === version) {
        setPage(result);
        const available = new Set(
          result.services
            .filter((service) => service.available !== false)
            .map((service) => service.id),
        );
        setSelectedServices((selected) =>
          selected.filter((id) => available.has(id)),
        );
      }
    } catch {
      if (revision.current === version)
        setError("External services could not be loaded. Please try again.");
    } finally {
      if (revision.current === version) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const onMessage = (event: MessageEvent) => {
      const flow = currentFlow.current;
      const data = event.data;
      if (
        !flow ||
        flow.handling ||
        !flow.state ||
        event.source !== flow.popup ||
        event.origin !== window.location.origin ||
        !data ||
        typeof data !== "object" ||
        data.type !== "durableclaw:oauth" ||
        data.state !== flow.state
      )
        return;
      const hasCode =
        typeof data.code === "string" &&
        data.code.length > 0 &&
        data.code.length <= 8192 &&
        data.error === undefined;
      const hasError =
        data.error === "access_denied" && data.code === undefined;
      if (!hasCode && !hasError) return;
      if (Date.now() >= flow.deadline) {
        currentFlow.current = null;
        closePopup(flow);
        setBusy(false);
        setError(expiredError);
        return;
      }
      flow.handling = true;
      closePopup(flow);
      void (async () => {
        try {
          const result = await api("/api/connectors/google/callback", {
            method: "POST",
            body: JSON.stringify({
              state: flow.state,
              ...(hasCode ? { code: data.code } : { error: "access_denied" }),
            }),
          });
          if (result?.connected !== true || hasError)
            throw new Error("OAuth failed");
          if (currentFlow.current !== flow) return;
          await load();
          if (currentFlow.current === flow)
            setNotice("Google Workspace connected.");
        } catch {
          if (currentFlow.current === flow) setError(connectError);
        } finally {
          if (currentFlow.current === flow) {
            currentFlow.current = null;
            setBusy(false);
          }
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => {
      revision.current++;
      window.removeEventListener("message", onMessage);
      if (currentFlow.current) closePopup(currentFlow.current);
      currentFlow.current = null;
    };
  }, [api, load]);

  const connect = () => {
    if (busy || loading || !page?.configured || selectedServices.length === 0)
      return;
    setError("");
    setNotice("");
    // Open during the click event so browser popup blockers preserve user intent.
    const popup = window.open(
      "about:blank",
      "durableclaw-google-oauth",
      "popup,width=600,height=750",
    );
    if (!popup) {
      setError(
        "Allow popups for this site, then connect Google Workspace again.",
      );
      return;
    }
    const flow: OAuthFlow = {
      popup,
      state: null,
      deadline: Date.now() + 600000,
      handling: false,
      popupClosed: false,
      timer: null,
    };
    currentFlow.current = flow;
    setBusy(true);
    flow.timer = setInterval(() => {
      if (currentFlow.current !== flow || flow.handling) return;
      if (popup.closed || Date.now() >= flow.deadline) {
        const cancelled = popup.closed;
        currentFlow.current = null;
        closePopup(flow);
        setBusy(false);
        setError(
          cancelled
            ? "Google Workspace connection was cancelled. Please try again."
            : expiredError,
        );
      }
    }, 1000);
    void (async () => {
      try {
        const result = await api("/api/connectors/google/connect", {
          method: "POST",
          body: JSON.stringify({
            services: page.services
              .filter(
                (service) =>
                  service.available !== false &&
                  selectedServices.includes(service.id),
              )
              .map((service) => service.id),
          }),
        });
        if (currentFlow.current !== flow) return;
        if (
          typeof result?.authorization_url !== "string" ||
          result.authorization_url.length > 16384
        )
          throw new Error("Invalid OAuth destination");
        const url = new URL(result.authorization_url);
        const state = url.searchParams.get("state");
        if (
          url.origin !== "https://accounts.google.com" ||
          url.pathname !== "/o/oauth2/v2/auth" ||
          url.username ||
          url.password ||
          url.hash ||
          !state ||
          state.length > 512 ||
          url.searchParams.getAll("state").length !== 1
        )
          throw new Error("Invalid OAuth destination");
        flow.state = state;
        if (
          typeof result.expires_at === "number" &&
          Number.isFinite(result.expires_at)
        )
          flow.deadline = Math.min(flow.deadline, result.expires_at);
        if (Date.now() >= flow.deadline)
          throw new Error("OAuth request expired");
        popup.location.assign(url.href);
      } catch {
        if (currentFlow.current === flow) {
          currentFlow.current = null;
          closePopup(flow);
          setBusy(false);
          setError(connectError);
        }
      }
    })();
  };

  const disconnect = async (connection: ServiceConnection) => {
    setBusy(true);
    setError("");
    setNotice("");
    const version = revision.current;
    try {
      const result = await api(
        `/api/connectors/${encodeURIComponent(connection.id)}`,
        { method: "DELETE" },
      );
      if (revision.current !== version) return;
      if (result?.disconnected !== true) throw new Error("Disconnect failed");
      setNotice(
        result.revoked === true
          ? "Google Workspace disconnected."
          : "Google Workspace disconnected here. Google could not confirm revocation. Remove its access in your Google Account settings.",
      );
      await load();
    } catch {
      if (revision.current === version)
        setError(
          "Google Workspace could not be disconnected. Please try again.",
        );
    } finally {
      setBusy(false);
    }
  };

  const google = page?.plugins.find((plugin) => plugin.id === "google");
  const needsReconnect = page?.connections.some(
    (connection) =>
      connection.provider === "google" &&
      connection.status === "reauth_required",
  );
  return (
    <section className="connections-section" aria-label="External services">
      <h3>External services</h3>
      <p>
        Enable read and write access for the selected Google services from the
        cloud. Review the selected permissions in Google before connecting.
        Actions that change external services require your approval here or with
        the buttons in your linked Telegram chat.
      </p>
      <div className="button-row">
        <button disabled={busy || loading} onClick={() => void load()}>
          Refresh services
        </button>
      </div>
      {loading && <p role="status">Loading external services…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {google && (
        <article className="record-card">
          <strong>{google.label}</strong>
          <p>{google.description}</p>
          {!page?.configured && (
            <p className="muted">
              The workspace operator must configure Google Workspace before you
              can connect an account.
            </p>
          )}
          <fieldset disabled={busy || loading || !page?.configured}>
            <legend>Services to authorize</legend>
            <p>
              Connecting authorizes the selected services for your Google
              account.
            </p>
            {page?.services.map((service) => (
              <div key={service.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={selectedServices.includes(service.id)}
                    disabled={
                      busy ||
                      loading ||
                      !page.configured ||
                      service.available === false
                    }
                    onChange={(event) =>
                      setSelectedServices((selected) =>
                        event.target.checked
                          ? [...selected, service.id]
                          : selected.filter((id) => id !== service.id),
                      )
                    }
                  />
                  {service.label}
                </label>
                {service.description && (
                  <p className="muted">{service.description}</p>
                )}
                {service.requires_workspace && (
                  <p className="muted">Requires a Google Workspace account.</p>
                )}
              </div>
            ))}
          </fieldset>
          {selectedServices.length === 0 && (
            <p className="notice">Select at least one service to connect.</p>
          )}
          <button
            disabled={
              busy ||
              loading ||
              !page?.configured ||
              selectedServices.length === 0
            }
            onClick={connect}
          >
            {needsReconnect
              ? "Reconnect Google Workspace"
              : "Connect Google Workspace"}
          </button>
          {currentFlow.current && !currentFlow.current.handling && (
            <p className="notice">
              Finish connecting in the Google popup. Keep this page open.
            </p>
          )}
        </article>
      )}
      {page?.connections.map((connection) => (
        <article className="record-card" key={connection.id}>
          <strong>{connection.account}</strong>
          <p>
            Services:{" "}
            {connection.services
              .map(
                (id) =>
                  page.services.find((service) => service.id === id)?.label ??
                  id,
              )
              .join(", ")}
          </p>
          <p>
            {connection.status === "reauth_required"
              ? "Reconnect required"
              : "Connected"}
          </p>
          <button
            disabled={busy || loading}
            onClick={() => void disconnect(connection)}
          >
            Disconnect {connection.account}
          </button>
        </article>
      ))}
    </section>
  );
}
