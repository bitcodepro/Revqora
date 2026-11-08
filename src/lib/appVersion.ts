import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

let request: Promise<string> | undefined;

export function useAppVersion() {
  const [version, setVersion] = useState<string | null>();
  useEffect(() => {
    let active = true;
    request ??= getVersion().catch((error) => {
      request = undefined;
      throw error;
    });
    void request.then(
      (value) => { if (active) setVersion(value); },
      () => { if (active) setVersion(null); },
    );
    return () => { active = false; };
  }, []);
  return version;
}
