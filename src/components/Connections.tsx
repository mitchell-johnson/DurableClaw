import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Api } from "../hooks/api";

interface Device {
  device_id: string;
  name: string;
  last_seen_at: number | null;
  revoked_at: number | null;
}
interface Plugin {
  id: string;
  label: string;
  configured: boolean;
}
interface Link {
  id: string;
  pluginId: string;
  senderId: string;
  conversationId: string;
}
interface Job {
  job_id: string;
  device_id: string;
  command: string;
  cwd: string;
  status: string;
  created_at: number;
  result_summary?: object | null;
  result?: {
    stdout: string;
    stderr: string;
    exit_code: number | null;
    timed_out: boolean;
    truncated: boolean;
    error?: string;
  } | null;
}
interface Delivery {
  requestId: string;
  pluginId: string;
  status: string;
  createdAt: number;
}
const when = (time: number) => new Date(time).toLocaleString();

export function Connections({
  api,
  conversationId,
}: {
  api: Api;
  conversationId: string | null;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<{
    code: string;
    expires_at: number;
  } | null>(null);
  const [linkCode, setLinkCode] = useState<{
    instruction: string;
    expiresAt: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const load = useCallback(async () => {
    const version = ++revision.current;
    const [devicePage, pluginPage, linkPage, jobPage, deliveryPage] =
      await Promise.all([
        api("/api/devices"),
        api("/api/messaging/plugins"),
        api("/api/messaging/links"),
        api("/api/devices/jobs"),
        api("/api/messaging/deliveries"),
      ]);
    if (revision.current !== version) return;
    setDevices(devicePage.devices);
    setPlugins(pluginPage.plugins);
    setLinks(linkPage.links);
    setJobs(jobPage.jobs);
    setDeliveries(deliveryPage.deliveries);
  }, [api]);
  useEffect(() => {
    void load().catch(() =>
      setError(
        "Connections could not be loaded. Check that the messaging and device migrations have been applied.",
      ),
    );
    return () => {
      revision.current++;
    };
  }, [load]);
  useEffect(() => {
    setLinkCode(null);
  }, [conversationId]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Connection request failed",
      );
    } finally {
      setBusy(false);
    }
  };
  const pair = (event: FormEvent) => {
    event.preventDefault();
    void action(async () => {
      setPairing(
        await api("/api/devices/enrollment", {
          method: "POST",
          body: JSON.stringify({ name: name.trim() }),
        }),
      );
      setName("");
    });
  };
  return (
    <section className="connections-section" aria-label="Messaging and devices">
      <div className="button-row">
        <button disabled={busy} onClick={() => void action(load)}>
          Refresh connections
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <h3>Messaging</h3>
      <p>
        Link a private chat to the conversation you currently have open. Review
        and approve actions in this web app.
      </p>
      {!conversationId && (
        <p className="notice">
          Open a conversation before creating a messaging link.
        </p>
      )}
      {plugins.map((plugin) => {
        const link = links.find((item) => item.pluginId === plugin.id);
        return (
          <article className="record-card" key={plugin.id}>
            <strong>{plugin.label}</strong>
            {link ? (
              <>
                <p>
                  Linked sender: <code>{link.senderId}</code>
                </p>
                <p className="muted">
                  Conversation: <code>{link.conversationId}</code>
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      revision.current++;
                      await api(
                        `/api/messaging/links/${encodeURIComponent(link.id)}`,
                        { method: "DELETE" },
                      );
                      setLinkCode(null);
                      await load();
                    })
                  }
                >
                  Unlink {plugin.label}
                </button>
              </>
            ) : (
              <>
                {!plugin.configured && (
                  <p className="muted">
                    The workspace operator must configure this plugin first.
                  </p>
                )}
                <button
                  disabled={busy || !plugin.configured || !conversationId}
                  onClick={() =>
                    void action(async () => {
                      setLinkCode(
                        await api("/api/messaging/link-codes", {
                          method: "POST",
                          body: JSON.stringify({
                            pluginId: plugin.id,
                            conversationId,
                          }),
                        }),
                      );
                    })
                  }
                >
                  Link {plugin.label}
                </button>
              </>
            )}
          </article>
        );
      })}
      {linkCode && (
        <div className="notice">
          <p>{linkCode.instruction}</p>
          <p>
            Expires {when(linkCode.expiresAt)}. Keep this code private. Refresh
            after linking to verify the sender.
          </p>
        </div>
      )}
      <h3>Your Macs</h3>
      <p>
        Pair each Mac separately. Approved commands run with the installing
        user's permissions. Revoking a device cancels queued commands; a command
        already running may finish.
      </p>
      <form onSubmit={pair}>
        <label>
          Device name
          <input
            value={name}
            maxLength={128}
            required
            onChange={(event) => setName(event.target.value)}
            placeholder="My MacBook"
          />
        </label>
        <button disabled={busy || !name.trim()} className="primary">
          Create pairing code
        </button>
      </form>
      {pairing && (
        <div className="notice">
          <p>On your Mac, from the DurableClaw source directory, run:</p>
          <pre>
            <code>{`node device-daemon/cli.mjs pair --server ${window.location.origin}`}</code>
          </pre>
          <p>Enter this private, single-use code when prompted:</p>
          <code className="pairing-code">{pairing.code}</code>
          <p>
            Expires {when(pairing.expires_at)}. Then run{" "}
            <code>node device-daemon/cli.mjs install</code> as your regular
            user. Requires Node.js 22.12 or newer.
          </p>
          <button onClick={() => setPairing(null)}>Hide pairing code</button>
        </div>
      )}
      {devices.map((device) => (
        <article className="record-card" key={device.device_id}>
          <strong>{device.name}</strong>
          <p className="muted">
            <code>{device.device_id}</code>
          </p>
          <p>
            {device.revoked_at
              ? "Revoked"
              : device.last_seen_at
                ? `Last seen ${when(device.last_seen_at)}`
                : "Waiting for first connection"}
          </p>
          {!device.revoked_at && (
            <button
              disabled={busy}
              aria-label={`Revoke ${device.name}`}
              onClick={() =>
                void action(async () => {
                  revision.current++;
                  await api(
                    `/api/devices/${encodeURIComponent(device.device_id)}`,
                    { method: "DELETE" },
                  );
                  await load();
                })
              }
            >
              Revoke device
            </button>
          )}
        </article>
      ))}
      {!devices.length && <p className="muted">No devices paired yet.</p>}
      <h3>Recent commands</h3>
      <p className="muted">
        Refresh to see results. An unknown outcome means the command may have
        run; inspect the device before requesting another execution.
      </p>
      {jobs.map((job) => (
        <article className="record-card" key={job.job_id}>
          <strong>
            {job.status} ·{" "}
            {devices.find((device) => device.device_id === job.device_id)
              ?.name ?? job.device_id}
          </strong>
          <p className="muted">
            {when(job.created_at)} · <code>{job.cwd}</code>
          </p>
          <pre>{job.command}</pre>
          {job.status === "queued" && (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api(
                    `/api/devices/jobs/${encodeURIComponent(job.job_id)}`,
                    { method: "DELETE" },
                  );
                  await load();
                })
              }
            >
              Cancel queued command
            </button>
          )}
          {job.result_summary && !job.result && (
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const detail = await api(
                    `/api/devices/jobs/${encodeURIComponent(job.job_id)}`,
                  );
                  setJobs((current) =>
                    current.map((item) =>
                      item.job_id === job.job_id
                        ? { ...item, result: detail.job.result }
                        : item,
                    ),
                  );
                })
              }
            >
              Load command output
            </button>
          )}
          {job.result && (
            <details>
              <summary>
                Command output · exit {job.result.exit_code ?? "unknown"}
                {job.result.timed_out ? " · timed out" : ""}
                {job.result.truncated ? " · shortened" : ""}
              </summary>
              {job.result.stdout && <pre>{job.result.stdout}</pre>}
              {job.result.stderr && <pre>{job.result.stderr}</pre>}
              {job.result.error && <p>{job.result.error}</p>}
            </details>
          )}
        </article>
      ))}
      {!jobs.length && (
        <p className="muted">
          Ask the agent to list your devices and run a command. It will request
          approval before queuing it.
        </p>
      )}
      {!!deliveries.length && (
        <details>
          <summary>Recent message deliveries</summary>
          {deliveries.map((delivery) => (
            <p key={delivery.requestId}>
              {delivery.pluginId}: {delivery.status} ·{" "}
              {when(delivery.createdAt)}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
