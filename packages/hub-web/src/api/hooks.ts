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
const eventCursors = new Map<string, { after: number; items: HandoffEventsResp['items'] }>();

export function useHandoffEvents(id: string | null, enabled: boolean) {
  return useQuery<HandoffEventsResp>({
    queryKey: ['handoff-events', id],
    queryFn: async () => {
      const key = id!;
      const st = eventCursors.get(key) ?? { after: 0, items: [] };
      // 游标推进式增量拉取：服务端每页 500，翻到短页为止。
      // 旧实现恒 after=0，长会话超过 500 条后后续日志永不渲染（窗口 bug）
      for (let page = 0; page < 10; page++) {
        const r = await fetchHandoffEvents(key, st.after);
        st.items = st.items.concat(r.items);
        st.after = r.nextAfter;
        if (r.items.length < 500) break;
      }
      eventCursors.set(key, st);
      return { items: st.items, nextAfter: st.after };
    },
    enabled: id !== null && enabled,
    refetchInterval: 2000,
  });
}
