"use client";

import { useRef, useState } from "react";

import { initialsOf } from "@/lib/tools/onboarding/people-types";
import { Btn } from "./toast";

/*
 * Pick a photo, resize it in the browser, hand back a small data URL.
 *
 * Ported from the orchestrator's `components/PhotoInput.tsx`. The resize is the
 * point: doing it here rather than on the server means a 6 MB phone photo never
 * leaves the tab — what gets saved is a ~8 KB square, so no storage bucket is
 * needed and the row stays light. That is also what keeps the 200 KB server-side
 * cap from ever being hit by an ordinary photo.
 *
 * Only the styling is the workspace's; the SIZE, QUALITY, centre-crop and JPEG
 * encoding are unchanged, so a photo added here is the same shape as one the live
 * tool stored.
 */

const SIZE = 128; // stored square, big enough for a crisp 30–64px avatar
const QUALITY = 0.82;

export async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height); // centre-crop to a square first
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not read that image");
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  );
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", QUALITY);
}

export function Avatar({ src, name, size = 40 }: { src: string | null; name?: string | null; size?: number }) {
  return (
    <span
      aria-hidden={src ? undefined : "true"}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--inset-2)",
        color: "var(--muted)",
        display: "grid",
        placeItems: "center",
        fontSize: Math.round(size / 2.6),
        fontWeight: 600,
        overflow: "hidden",
        flex: "none",
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- data URLs, no loader needed
        <img src={src} alt={name ?? "photo"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

export function PhotoInput({
  value,
  name,
  onChange,
  disabled,
  size = 40,
}: {
  value: string | null;
  name?: string | null;
  onChange: (photo: string | null) => void;
  disabled?: boolean;
  size?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file?: File) => {
    if (!file) return;
    setError(null);
    try {
      onChange(await toAvatarDataUrl(file));
    } catch {
      setError("couldn't read that image");
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Avatar src={value} name={name} size={size} />
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn
            disabled={disabled}
            style={{ padding: "6px 11px", fontSize: 12.5 }}
            onClick={() => input.current?.click()}
          >
            {value ? "Change" : "Add photo"}
          </Btn>
          {value && (
            <Btn
              disabled={disabled}
              style={{ padding: "6px 11px", fontSize: 12.5 }}
              onClick={() => {
                onChange(null);
                setError(null);
              }}
            >
              Remove
            </Btn>
          )}
        </div>
        {error && (
          <span style={{ fontSize: 12, color: "var(--red)" }}>{error}</span>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
