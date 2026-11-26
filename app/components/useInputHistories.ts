"use client";

import { useCallback, useEffect, useState } from "react";

export type InputHistories = Record<string, string[]>;

export function useInputHistories() {
  const [histories, setHistories] = useState<InputHistories>({});

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/histories", { cache: "no-store" });
      if (!response.ok) return;
      const json = (await response.json()) as { histories?: InputHistories };
      setHistories(json.histories ?? {});
    } catch {
      // 履歴が取れなくても入力は継続できる
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { histories, refresh };
}
