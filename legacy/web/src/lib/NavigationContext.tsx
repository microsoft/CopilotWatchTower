import { createContext, useContext } from "react";

import type { NavKey } from "../components/Sidebar";

// Lightweight navigation channel so deep components (e.g. LockedNotice, source
// routing) can switch the active page without prop-drilling through every page.
export const NavigationContext = createContext<(key: NavKey) => void>(() => undefined);

export function useNavigate(): (key: NavKey) => void {
  return useContext(NavigationContext);
}
