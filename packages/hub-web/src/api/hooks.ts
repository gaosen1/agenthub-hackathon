/**
 * TanStack Query hooks——列表 5s 轮询、详情 3s 轮询（running 时日志"准实时"）
 */
import { useQuery } from '@tanstack/react-query';
import type { HandoffDetail, ListHandoffsResp } from '@agenthub/shared/contracts';
import { fetchHandoffDetail, fetchHandoffs } from './client.js';

export function useHandoffs() {
  return useQuery<ListHandoffsResp>({
    queryKey: ['handoffs'],
    queryFn: fetchHandoffs,
    refetchInterval: 5000,
  });
}

export function useHandoffDetail(id: string | null) {
  return useQuery<HandoffDetail>({
    queryKey: ['handoff', id],
    queryFn: () => fetchHandoffDetail(id!),
    enabled: id !== null,
    refetchInterval: 3000,
  });
}
