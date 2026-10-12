"use client";

import { useEffect, useState } from "react";
import { PanelLeft } from "lucide-react";

import { clientsPanelShowing, toggleClientsPanel, useClientsPanel } from "./clients-panel";

/*
 * "Clients" — shows and hides the client list beside an open conversation.
 *
 * In the filter bar, at its left end, directly above where the panel appears.
 * On a wide stage it hides the column (and that is remembered); on a narrow
 * one it opens the panel as a drawer. Which of the two is the stylesheet's
 * call — see clients-panel.ts and mi-inbox.css.
 *
 * `aria-expanded` is filled in after mount: whether the panel is on screen
 * depends on a container query, which the server cannot know. Nothing is
 * styled from it, so the late value moves no pixels.
 */
export function ClientsToggle({ initialCollapsed }: { initialCollapsed: boolean }) {
  const { collapsed, drawer } = useClientsPanel(initialCollapsed);
  const [showing, setShowing] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    setShowing(clientsPanelShowing(initialCollapsed));
  }, [collapsed, drawer, initialCollapsed]);

  return (
    <button
      type="button"
      className="mi-clients-toggle"
      aria-controls="mi-client-lists"
      aria-expanded={showing}
      title="Show or hide the client list"
      onClick={() => toggleClientsPanel(initialCollapsed)}
    >
      <PanelLeft aria-hidden="true" strokeWidth={2} />
      Clients
    </button>
  );
}
