"use client";

import { createContext, useContext } from "react";

/*
 * May the person looking at the Clients screen open the new client portal? (24 Nov: the Portal buttons open the
 * new portal, which lets in staff with the Client Portals switch — lib/crm-preview/access.ts.) Decided by the page
 * from the signed session; without it the buttons show the portal's name, not a link that would answer Not found.
 */
export const PortalAccess = createContext(false);

export const usePortalAccess = (): boolean => useContext(PortalAccess);
