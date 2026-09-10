import { useState, type FormEvent } from "react";
import { authClient, accountError, authErrorStatus } from "../hooks/authClient";

export function NativeLogin({
  accessRecovery,
  onAuthenticated,
  sessionError = "",
}: {
  accessRecovery: boolean;
  onAuthenticated: () => Promise<void>;
  sessionError?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<"password" | "passkey" | null>(null);
  const [error, setError] = useState("");
  async function signIn(kind: "password" | "passkey") {
    if (pending) return;
    setPending(kind);
    setError("");
    let authenticated = false;
    try {
      const result =
        kind === "password"
          ? await authClient.signIn.email({ email: email.trim(), password })
          : await authClient.signIn.passkey();
      if (result.error) throw result.error;
      authenticated = true;
      setPassword("");
      await onAuthenticated();
    } catch (error) {
      setError(
        authenticated
          ? "You signed in, but the workspace could not be opened. Please try signing in again."
          : kind === "password" &&
              [400, 401].includes(authErrorStatus(error) ?? 0)
            ? "Email or password could not be verified. Please try again."
            : accountError(
                error,
                kind === "passkey"
                  ? "The passkey request was cancelled or could not be completed. Try again, or sign in with your password."
                  : "Sign-in could not be completed. Please try again.",
              ),
      );
    } finally {
      setPassword("");
      setPending(null);
    }
  }
  return (
    <main className="login">
      <section
        className="login-card native-login"
        aria-labelledby="native-login-title"
      >
        <div className="brand-mark">D</div>
        <h1 id="native-login-title">DurableClaw</h1>
        <p>Your persistent agent workspace.</p>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void signIn("password");
          }}
          aria-label="Sign in with a password"
        >
          <label>
            Email
            <input
              type="email"
              autoComplete="username webauthn"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={pending !== null}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={128}
              required
              disabled={pending !== null}
            />
          </label>
          {(error || sessionError) && (
            <p role="alert" className="error">
              {error || sessionError}
            </p>
          )}
          <button
            className="primary"
            disabled={pending !== null || !email.trim() || !password}
          >
            {pending === "password" ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="auth-divider" aria-hidden="true">
          or
        </div>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void signIn("passkey")}
        >
          {pending === "passkey"
            ? "Waiting for passkey…"
            : "Sign in with a passkey"}
        </button>
        <p className="muted">
          Forgot your password? Sign in with a passkey, then set a new password
          in Account security.
        </p>
        {accessRecovery && (
          <p className="auth-recovery">
            <a href="/api/auth/access">Sign in with GitHub</a>
            <span className="muted">
              Set up your account or continue through your workspace’s GitHub
              sign-in.
            </span>
          </p>
        )}
      </section>
    </main>
  );
}
