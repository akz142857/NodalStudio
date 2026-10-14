import { useQuery } from "@tanstack/react-query";
import type { DatabaseSnapshot, NodalStudioPlatform, RuntimeInfo } from "../platform";

export function useComparisonSnapshot(
  id: string, current: DatabaseSnapshot, platform: NodalStudioPlatform, runtimeKind?: RuntimeInfo["kind"],
) {
  const available = current.id === id ? current : undefined;
  const query = useQuery({
    queryKey: ["diff-snapshot", id],
    queryFn: async () => {
      const snapshot = await platform.getSnapshot(id);
      if (snapshot.id !== id) throw new Error("The returned snapshot does not match this comparison.");
      return snapshot;
    },
    enabled: runtimeKind === "desktop" && !available,
    retry: false,
    staleTime: Infinity,
  });
  return {
    snapshot: available ?? query.data,
    loading: !available && !query.data && (query.isFetching || (!query.isError && runtimeKind !== "web")),
    error: query.error?.message,
    retry: () => void query.refetch(),
  };
}

export type SnapshotState = ReturnType<typeof useComparisonSnapshot>;
