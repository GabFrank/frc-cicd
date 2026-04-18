"use client";

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";

interface PollOptions {
  refetchInterval?: number;
  enabled?: boolean;
}

export function usePollJson<T>(
  url: string,
  key: string[] = [url],
  options?: PollOptions,
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json();
    },
    refetchInterval: options?.refetchInterval ?? 30_000,
    refetchIntervalInBackground: true,
    placeholderData: (prev) => prev,
    enabled: options?.enabled,
  } as UseQueryOptions<T>);
}
