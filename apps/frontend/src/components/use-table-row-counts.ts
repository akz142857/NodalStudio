import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { DataSourceProfile, NodalStudioPlatform } from "../platform";
import { tableRowCountKey, type TableRowCountRequest, type TableRowCountTarget } from "../platform/table-row-counts";

export interface TableRowCounts {
  values: ReadonlyMap<string, { count: string; exact: boolean }>;
  request: (target: TableRowCountTarget) => void;
  busy: boolean;
  pending?: string;
  failed?: string;
}

export function useTableRowCounts(platform: NodalStudioPlatform, profile: DataSourceProfile | undefined, visible: boolean): TableRowCounts | undefined {
  const sourceId = profile?.id;
  const revision = profile?.updatedAt;
  const scope = JSON.stringify([sourceId, revision]);
  const [exact, setExact] = useState(() => new Map<string, ReadonlyMap<string, string>>());
  const estimates = useQuery({
    queryKey: ["table-row-estimates", sourceId, revision],
    queryFn: () => platform.readTableRowCounts({ sourceId: profile!.id, connectionRevision: profile!.updatedAt }),
    enabled: Boolean(profile && profile.databaseType !== "sqlite" && visible),
    staleTime: 120_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const count = useMutation({
    mutationFn: async (input: TableRowCountRequest) => {
      const [value] = await platform.readTableRowCounts(input);
      if (!value) throw new Error("The database did not return a row count.");
      return value;
    },
    onSuccess: (value, input) => {
      const key = JSON.stringify([input.sourceId, input.connectionRevision]);
      setExact((previous) => new Map(previous).set(key, new Map(previous.get(key)).set(tableRowCountKey(value), value.count)));
    },
  });
  const exactCounts = exact.get(scope);
  const values = useMemo(() => {
    const counts = new Map((estimates.data ?? []).map((row) => [tableRowCountKey(row), { count: row.count, exact: false }]));
    for (const [key, count] of exactCounts ?? []) counts.set(key, { count, exact: true });
    return counts;
  }, [estimates.data, exactCounts]);
  const input = count.variables;
  const target = input && input.sourceId === sourceId && input.connectionRevision === revision && input.target;
  const key = target ? tableRowCountKey(target) : undefined;
  const { mutate, isPending, isError } = count;
  const request = useCallback(({ schema, name }: TableRowCountTarget) => {
    if (sourceId && revision && !isPending) mutate({ sourceId, connectionRevision: revision, target: { schema, name } });
  }, [isPending, mutate, revision, sourceId]);
  const pending = isPending ? key : undefined;
  const failed = isError ? key : undefined;
  return useMemo(() => profile && {
    values,
    busy: isPending,
    pending,
    failed,
    request,
  }, [profile, values, isPending, pending, failed, request]);
}
