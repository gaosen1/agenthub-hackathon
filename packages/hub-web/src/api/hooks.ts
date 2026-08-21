/**
 * TanStack Query hooks——列表 5s 轮询、详情 3s 轮询、事件日志 2s 轮询
 */
import { useQuery } from '@tanstack/react-query';
import type { HandoffDetail, HandoffEventsResp, ListHandoffsResp } from '@agenthub/shared/contracts';
import { fetchHandoffDetail, fetchHandoffEvents, fetchHandoffs } from './client.js';

export function useHandoffs(showArchived = false) {
  return useQuery<ListHandoffsResp>({
    queryKey: ['handoffs', showArchived],
    queryFn: () => fetchHandoffs(showArchived),
    refetchInterval: 5000,
  });
}

export function useHandoffDetail(id: string | null) {
  return useQuery<HandoffDetail>({
    queryKey: ['handoff', id],
    queryFn: () => fetchHandoffDetail(id!),
    enabled: id !== null,
    refetchInterval: 3000,
    retry: false,
  });
}

/** 真 Hub 的状态时间线 + 日志事件流（mock 模式返回空，组件回退 mockExtras） */
export function useHandoffEvents(id: string | null, enabled: boolean) {
  return useQuery<HandoffEventsResp>({
    queryKey: ['handoff-events', id],
    queryFn: () => fetchHandoffEvents(id!),
    enabled: id !== null && enabled,
    refetchInterval: 2000,
  });
}
