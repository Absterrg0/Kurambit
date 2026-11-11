import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";

/**
 * A new game starts in one place, Home's brief box. Every way in (the sidebar,
 * the palette, mod+N, a link, onboarding) leaves a request here and goes Home;
 * the box takes it when it mounts or, already mounted, when it changes.
 */
// Never reused, so the box can tell a new request from one it already took.
let lastBoxRequestId = 0;

export const useGameEntryStore = create<{
  /** The Open a game dialog. */
  openDialog: boolean;
  /** A request for the brief box to take focus, with a brief to put in it. */
  boxRequest: { readonly id: number; readonly brief: string | null } | null;
  showOpenDialog: (open: boolean) => void;
  requestBox: (brief: string | null) => void;
  takeBoxRequest: () => void;
}>((set) => ({
  openDialog: false,
  boxRequest: null,
  showOpenDialog: (openDialog) => set({ openDialog }),
  requestBox: (brief) => {
    lastBoxRequestId += 1;
    set({ boxRequest: { id: lastBoxRequestId, brief } });
  },
  takeBoxRequest: () => set({ boxRequest: null }),
}));

/** Goes Home with the brief box focused, holding `brief` when one is given. */
export function useNewGame() {
  const navigate = useNavigate();
  return (options?: { readonly brief?: string; readonly replace?: boolean }) => {
    useGameEntryStore.getState().requestBox(options?.brief ?? null);
    void navigate({ to: "/", replace: options?.replace ?? false });
  };
}

export const showOpenGameDialog = () => useGameEntryStore.getState().showOpenDialog(true);
