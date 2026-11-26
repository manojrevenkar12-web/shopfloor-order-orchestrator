import { useCallback, useEffect, useState } from "react";
import type { Results } from "./types";

export type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: Results };

export function useResults(url = "./data/results.json"): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`results.json: HTTP ${r.status}`);
        return r.json() as Promise<Results>;
      })
      .then((data) => live && setLoad({ state: "ready", data }))
      .catch((e: unknown) => live && setLoad({ state: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [url, attempt]);

  return [load, retry];
}
