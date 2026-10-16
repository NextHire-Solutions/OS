"use client";

/*
 * The design's support chat (Chat), opened from the button at the bottom
 * right. The chat itself is not built: this is the design's own example
 * conversation, word for word — its "Today" marked "Example conversation" so
 * no one takes it for a real one — and sending, the suggestions and the link
 * in it are inert (k.ts RO).
 */

import { useEffect } from "react";

import { Icon } from "./icons";
import { RO } from "./k";

export function ChatWindow({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
      <section role="dialog" aria-label="Support chat" style={{ position: "fixed", right: 24, bottom: 92, zIndex: 12, width: 380, height: 600, boxSizing: "border-box", background: "#f7f8fa", borderRadius: 18, boxShadow: "0 24px 60px rgba(31,33,36,0.22)", display: "flex", flexDirection: "column", fontFamily: "var(--crx-font), 'Inter Tight', system-ui, sans-serif", fontSize: 13, color: "#1f2124", overflow: "hidden" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 16px 18px", background: "#3e6bd1", color: "#fff" }}>
          <span style={{ position: "relative", width: 38, height: 38, borderRadius: 99, background: "#fff", color: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="bot" size={20} />
            <span style={{ position: "absolute", bottom: "0", right: "0", width: 10, height: 10, borderRadius: 99, background: "#22c55e", border: "2px solid #3e6bd1" }} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              BrokerStaffer Assistant
            </div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Online · Our team can join anytime
            </div>
          </div>
          <button type="button" aria-label="Minimize chat" onClick={onClose} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", width: 30, height: 30, borderRadius: 8, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="chevDown" size={18} />
          </button>
        </header>
        <div style={{ flex: 1, overflow: "auto", padding: "16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ alignSelf: "center", fontSize: 11, color: "#6b7280", padding: "2px 10px", borderRadius: 99, background: "#eef0f3" }}>
            Example conversation
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-start", maxWidth: "86%" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <span style={{ width: 28, height: 28, borderRadius: 99, background: "#eef2fa", color: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name="bot" size={16} />
              </span>
              <div style={{ background: "#ffffff", border: "1px solid #ebedf0", color: "#1f2124", padding: "10px 12px", borderRadius: "14px 14px 14px 4px", lineHeight: 1.55 }}>
                Hi Maria! I am the BrokerStaffer assistant. What can I help you with?
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginLeft: 36 }}>
            <button type="button" {...RO} style={{ height: 30, padding: "0 12px", border: "1px solid #c9d6f2", borderRadius: 99, background: "#fff", fontSize: 12, fontWeight: 500, color: "#2f55a8", cursor: "pointer", whiteSpace: "nowrap" }}>
              Block a sister office
            </button>
            <button type="button" {...RO} style={{ height: 30, padding: "0 12px", border: "1px solid #c9d6f2", borderRadius: 99, background: "#fff", fontSize: 12, fontWeight: 500, color: "#2f55a8", cursor: "pointer", whiteSpace: "nowrap" }}>
              Add a teammate
            </button>
            <button type="button" {...RO} style={{ height: 30, padding: "0 12px", border: "1px solid #c9d6f2", borderRadius: 99, background: "#fff", fontSize: 12, fontWeight: 500, color: "#2f55a8", cursor: "pointer", whiteSpace: "nowrap" }}>
              Change my emails
            </button>
            <button type="button" {...RO} style={{ height: 30, padding: "0 12px", border: "1px solid #c9d6f2", borderRadius: 99, background: "#fff", fontSize: 12, fontWeight: 500, color: "#2f55a8", cursor: "pointer", whiteSpace: "nowrap" }}>
              Billing question
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-end", maxWidth: "80%" }}>
            <div style={{ background: "#3e6bd1", color: "#fff", padding: "9px 12px", borderRadius: "14px 14px 4px 14px", lineHeight: 1.5 }}>
              How do I stop emailing a sister office?
            </div>
            <span style={{ fontSize: 11, color: "#6b7280", alignSelf: "flex-end" }}>
              7:41 PM
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-start", maxWidth: "86%" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <span style={{ width: 28, height: 28, borderRadius: 99, background: "#eef2fa", color: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name="bot" size={16} />
              </span>
              <div style={{ background: "#ffffff", border: "1px solid #ebedf0", color: "#1f2124", padding: "10px 12px", borderRadius: "14px 14px 14px 4px", lineHeight: 1.55 }}>
                Add the office to your DNC List as a company. We block every agent with an email at that&nbsp;domain.
                <br />
                <br />
                1. Open{" "}
                <b>
                  DNC List
                </b>
                <br />
                2. Click{" "}
                <b>
                  Add to DNC
                </b>
                <br />
                3. Choose{" "}
                <b>
                  Company
                </b>
                {" "}and enter the domain
                <br />
                <br />
                <a href="#" {...RO} style={{ color: "#3e6bd1", fontWeight: 600 }}>
                  Add a company now
                </a>
              </div>
            </div>
            <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 36 }}>
              7:41 PM
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "flex-end", maxWidth: "80%" }}>
            <div style={{ background: "#3e6bd1", color: "#fff", padding: "9px 12px", borderRadius: "14px 14px 4px 14px", lineHeight: 1.5 }}>
              Thanks! Can someone check my emails too?
            </div>
            <span style={{ fontSize: 11, color: "#6b7280", alignSelf: "flex-end" }}>
              7:42 PM
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, alignSelf: "flex-start" }}>
            <span style={{ width: 28, height: 28, borderRadius: 99, background: "#eef2fa", color: "#3e6bd1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon name="bot" size={16} />
            </span>
            <div style={{ background: "#fff", border: "1px solid #ebedf0", padding: "12px 14px", borderRadius: "14px 14px 14px 4px", display: "flex", gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 1 }} />
              <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 0.7 }} />
              <span style={{ width: 6, height: 6, borderRadius: 99, background: "#a0a7b4", opacity: 0.4 }} />
            </div>
          </div>
        </div>
        <div style={{ padding: "10px 12px 12px", background: "#fff", borderTop: "1px solid #ebedf0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 4px 14px", border: "1px solid #e3e6eb", borderRadius: 99 }}>
            <input type="text" placeholder="Type a message..." aria-label="Message" style={{ flex: 1, border: "0", outline: "0", fontSize: 13, fontFamily: "inherit", background: "transparent" }} />
            <button type="button" aria-label="Send" {...RO} style={{ width: 34, height: 34, border: "0", borderRadius: 99, background: "#3e6bd1", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
              <Icon name="campaigns" size={15} />
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", textAlign: "center", marginTop: 8 }}>
            Automated assistant · Ask for a person anytime
          </div>
        </div>
      </section>
  );
}
