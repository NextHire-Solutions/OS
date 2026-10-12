/*
 * The cookie that remembers "I hid the Clients panel beside a conversation".
 *
 * Its own file, with no hooks and no "use client", because two sides read it:
 * the server (thread-detail.tsx, to draw the panel hidden on the first paint
 * rather than flashing it in and out) and the browser (clients-panel.ts, which
 * writes it). A constant exported from a client module reaches a server
 * component as a reference, not a string.
 *
 * A cookie rather than localStorage — which is where the panel's WIDTH lives —
 * for that first paint: width is restored after mount and nudges a border,
 * while hidden-or-not moves every column on the screen.
 */
export const CLIENTS_PANEL_COOKIE = "mi_clients_panel";
export const CLIENTS_PANEL_HIDDEN = "hidden";
