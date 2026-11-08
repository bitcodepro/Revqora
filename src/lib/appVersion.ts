import { getVersion } from "@tauri-apps/api/app";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export const appVersion = createStore<{
  version: string | null | undefined;
  load: () => Promise<void>;
}>((set, get) => {
  let request: Promise<void> | undefined;
  return {
    version: undefined,
    load: async () => {
      if (get().version != null) return;
      if (!request) {
        request = getVersion().then(
          (version) => set({ version }),
          () => set({ version: null }),
        ).finally(() => { request = undefined; });
        if (get().version === null) set({ version: undefined });
      }
      await request;
    },
  };
});

export function useAppVersion() {
  const version = useStore(appVersion, (state) => state.version);
  useEffect(() => { void appVersion.getState().load(); }, []);
  return version;
}
