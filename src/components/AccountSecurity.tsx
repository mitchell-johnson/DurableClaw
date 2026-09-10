import { useEffect, useState, type FormEvent } from "react";
import {
  accountError,
  authClient,
  authErrorStatus,
  authRequest,
  AuthRequestError,
} from "../hooks/authClient";

interface SecurityState {
  email: string;
  passwordSet: boolean;
  passkeys: {
    id: string;
    name?: string | null;
    createdAt?: string | number | null;
  }[];
  fresh: boolean;
  canRecover: boolean;
  enrollmentPending?: boolean;
}

export function AccountSecurity({
  accessRecovery,
  onSignInAgain,
}: {
  accessRecovery: boolean;
  onSignInAgain: () => void | Promise<void>;
}) {
  const [security, setSecurity] = useState<SecurityState | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [recover, setRecover] = useState(false);
  const [name, setName] = useState("");
  const [removeId, setRemoveId] = useState<string | null>(null);

  async function load(): Promise<SecurityState> {
    const data = await authRequest<SecurityState>("/api/auth/security");
    if (
      typeof data?.email !== "string" ||
      !Array.isArray(data.passkeys) ||
      typeof data.fresh !== "boolean"
    )
      throw new Error("Invalid account response");
    return data;
  }
  useEffect(() => {
    let active = true;
    void load()
      .then((data) => {
        if (active) setSecurity(data);
      })
      .catch((error) => {
        if (active)
          setError(
            accountError(
              error,
              "Account security could not be loaded. Try again.",
            ),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function refresh() {
    setError("");
    setLoading(true);
    try {
      setSecurity(await load());
    } catch (error) {
      setError(
        accountError(error, "Account security could not be loaded. Try again."),
      );
    } finally {
      setLoading(false);
    }
  }
  async function fresh(): Promise<SecurityState> {
    const current = await load();
    setSecurity(current);
    if (!current.fresh) throw new AuthRequestError(403);
    return current;
  }
  async function action(work: () => Promise<void>, success: string) {
    if (pending) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await work();
      setMessage(success);
      try {
        setSecurity(await load());
      } catch {
        setSecurity(null);
        setError(
          "Your account change was saved. Refresh account security before making another change.",
        );
      }
    } catch (error) {
      if ([401, 403].includes(authErrorStatus(error) ?? 0))
        setSecurity((value) => (value ? { ...value, fresh: false } : null));
      setError(
        accountError(
          error,
          "The account change could not be completed. Please try again.",
        ),
      );
    } finally {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setPending(false);
    }
  }
  async function password(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (newPassword.length < 15 || newPassword.length > 128) {
      setError("Use a password between 15 and 128 characters.");
      return;
    }
    if (newPassword !== confirmation) {
      setError("New passwords must match.");
      return;
    }
    if (security?.passwordSet && !recover && !currentPassword) {
      setError("Enter your current password.");
      return;
    }
    await action(
      async () => {
        const current = await fresh();
        if (recover && (!current.canRecover || !current.passwordSet))
          throw new AuthRequestError(403);
        if (current.passwordSet && !recover && !currentPassword)
          throw new Error("Current password required");
        await authRequest(
          current.passwordSet
            ? recover
              ? "/api/auth/recover-password"
              : "/api/auth/change-password"
            : "/api/auth/set-password",
          current.passwordSet && !recover
            ? { currentPassword, newPassword, revokeOtherSessions: true }
            : { newPassword },
        );
        setRecover(false);
      },
      security?.passwordSet
        ? "Password updated. Other sessions have been signed out."
        : "Password set.",
    );
  }
  async function addPasskey(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      await fresh();
      const result = await authClient.passkey.addPasskey({
        name: name.trim() || undefined,
      });
      if (result.error) throw result.error;
      setName("");
    }, "Passkey added.");
  }
  async function removePasskey(id: string) {
    await action(async () => {
      const current = await fresh();
      if (!current.passkeys.some((key) => key.id === id))
        throw new Error("Passkey unavailable");
      const result = await authClient.passkey.deletePasskey({ id });
      if (result.error) throw result.error;
      setRemoveId(null);
    }, "Passkey removed.");
  }
  async function signInAgain() {
    try {
      await onSignInAgain();
    } catch {
      setError("Sign-out could not be completed. Please try again.");
    }
  }
  const disabled = pending || !security?.fresh;
  return (
    <section
      className="account-security"
      aria-labelledby="account-security-title"
    >
      <h3 id="account-security-title">Account security</h3>
      {loading && !security && <p>Loading account security…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {!security && !loading && (
        <div className="button-row">
          <button onClick={() => void refresh()}>Try again</button>
          {accessRecovery && (
            <a href="/api/auth/access">Set up sign-in with GitHub</a>
          )}
        </div>
      )}
      {security && (
        <>
          <p className="muted">Signed in as {security.email}</p>
          {!security.fresh && (
            <div className="notice">
              {security.enrollmentPending === true ? (
                <>
                  <p>
                    First-time setup needs a recent GitHub sign-in. Sign out of
                    Cloudflare Access, then return here and sign in with GitHub.
                    This also signs you out of other Access apps.
                  </p>
                  <a href="/cdn-cgi/access/logout">
                    Sign out of Cloudflare Access
                  </a>
                </>
              ) : (
                <>
                  <p>
                    Sign in again before changing your password or passkeys. Use
                    your password or a passkey; account changes require a
                    sign-in from the last five minutes.
                  </p>
                  <button disabled={pending} onClick={() => void signInAgain()}>
                    Sign in again
                  </button>
                </>
              )}
            </div>
          )}
          <form onSubmit={password} aria-label="Manage password">
            <fieldset disabled={disabled}>
              <legend>
                {security.passwordSet
                  ? "Change password"
                  : "Set your first password"}
              </legend>
              {security.passwordSet && !recover && (
                <label>
                  Current password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    maxLength={128}
                    required
                  />
                </label>
              )}
              <label>
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={15}
                  maxLength={128}
                  required
                  aria-describedby="password-length"
                />
              </label>
              <p className="muted" id="password-length">
                Use 15–128 characters. A long, unique passphrase works well.
              </p>
              <label>
                Confirm new password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  minLength={15}
                  maxLength={128}
                  required
                />
              </label>
              {security.passwordSet && security.canRecover && (
                <label className="security-checkbox">
                  <input
                    type="checkbox"
                    checked={recover}
                    onChange={(event) => {
                      setRecover(event.target.checked);
                      setCurrentPassword("");
                    }}
                  />
                  Set a new password without the current password
                </label>
              )}
              <button className="primary" disabled={disabled}>
                {pending
                  ? "Saving…"
                  : security.passwordSet
                    ? recover
                      ? "Set a new password"
                      : "Change password"
                    : "Set password"}
              </button>
            </fieldset>
          </form>
          {security.passwordSet && !security.canRecover && (
            <p className="muted">
              Forgot your password? Sign in with a passkey, then set a new
              password in Account security.
            </p>
          )}
          <div className="passkey-settings">
            <h4>Passkeys</h4>
            <p className="muted">
              Sign in using your device’s fingerprint, face recognition, PIN, or
              security key.
            </p>
            {security.passkeys.length ? (
              <ul className="passkey-list">
                {security.passkeys.map((key) => (
                  <li key={key.id}>
                    <div>
                      <strong>{key.name || "Passkey"}</strong>
                      {key.createdAt &&
                        Number.isFinite(new Date(key.createdAt).getTime()) && (
                          <span className="muted">
                            Added {new Date(key.createdAt).toLocaleDateString()}
                          </span>
                        )}
                    </div>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={`Remove ${key.name || "passkey"}`}
                      onClick={() => setRemoveId(key.id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No passkeys added yet.</p>
            )}
            {removeId && (
              <div
                className="notice"
                role="group"
                aria-label="Confirm passkey removal"
              >
                <p>
                  Remove{" "}
                  {security.passkeys.find((key) => key.id === removeId)?.name ||
                    "this passkey"}
                  ? You won’t be able to use it to sign in again.
                </p>
                <div className="button-row">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setRemoveId(null)}
                  >
                    Keep passkey
                  </button>
                  <button
                    className="danger"
                    type="button"
                    disabled={disabled}
                    onClick={() => void removePasskey(removeId)}
                  >
                    Confirm removal
                  </button>
                </div>
              </div>
            )}
            <form onSubmit={addPasskey} aria-label="Add a passkey">
              <fieldset disabled={disabled}>
                <label>
                  Passkey name
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="For example, MacBook or security key"
                    maxLength={64}
                    autoComplete="off"
                  />
                </label>
                <button disabled={disabled}>Add passkey</button>
              </fieldset>
            </form>
          </div>
        </>
      )}
    </section>
  );
}
