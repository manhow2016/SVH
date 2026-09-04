import { create } from "zustand";

/** Session UI State（文档 §42）。 */
interface SessionUIState {
  currentSessionId: string | null;
  isRunning: boolean;
  setCurrentSessionId: (id: string | null) => void;
  setIsRunning: (running: boolean) => void;
}

export const useSessionStore = create<SessionUIState>((set) => ({
  currentSessionId: null,
  isRunning: false,
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  setIsRunning: (running) => set({ isRunning: running }),
}));
