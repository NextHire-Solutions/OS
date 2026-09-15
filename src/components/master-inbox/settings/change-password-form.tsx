"use client";

import { useState } from "react";
import { Field, ToastHost, useShowToast } from "./ui";

/*
 * Change password.
 *
 * The three fields, the match check, the 8-character minimum and the POST are
 * unchanged. What changed is that the form is drawn with the design's `.inp`
 * and its own field labels, and that its messages are visible: `sonner`'s
 * `toast` was reporting both success and failure into a `<Toaster />` this app
 * has never mounted, so "New passwords don't match" appeared nowhere at all.
 */

export function ChangePasswordForm() {
  return (
    <ToastHost>
      <ChangePasswordBody />
    </ToastHost>
  );
}

function ChangePasswordBody() {
  const show = useShowToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      show({ text: "New passwords don't match", bad: true });
      return;
    }
    if (next.length < 8) {
      show({ text: "New password must be at least 8 characters", bad: true });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tools/master-inbox/account/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const body = await res.json();
      if (!res.ok) {
        show({ text: body.error ?? "Could not change password", bad: true });
        return;
      }
      show({ text: "Password updated" });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch {
      show({ text: "Could not change password", bad: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mis-form" style={{ maxWidth: 460 }}>
      <Field label="Current password" htmlFor="cur">
        <input
          id="cur"
          className="inp"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="New password" htmlFor="new" hint="At least 8 characters.">
        <input
          id="new"
          className="inp"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="conf">
        <input
          id="conf"
          className="inp"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <div>
        <button
          type="submit"
          className="btn btn-pri"
          disabled={submitting}
          data-mis="update-password"
          style={submitting ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
        >
          {submitting ? "Updating…" : "Update password"}
        </button>
      </div>
    </form>
  );
}
