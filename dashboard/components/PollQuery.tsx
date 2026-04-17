"use client";

import { useQuery } from "@tanstack/react-query";

export function usePollJson<T>(url: string, key: string[] = [url]) {
  return useQuery<T>({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    },
  });
}
