/* 变更引擎：与 React 无关的纯函数，便于单元测试 */

export const clone = (v) => JSON.parse(JSON.stringify(v));
export const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const PRIORITY = { 3: '高', 2: '中', 1: '低' };

// 旧版本边格式 ['a','b'] → {id,source,target}
export function migrate(raw) {
  return {
    nodes: raw.nodes ?? [],
    edges: (raw.edges ?? []).map((e) =>
      Array.isArray(e)
        ? { id: `e-${[e[0], e[1]].sort().join('-')}`, source: e[0], target: e[1] }
        : e
    ),
  };
}

export const windowActive = (w, ts) => w.start <= ts && ts <= w.end;
export const windowStatus = (w, ts) =>
  w.end < ts ? 'ended' : w.start > ts ? 'scheduled' : 'active';

const nodeByIdIn = (d, id) => d.nodes.find((n) => n.id === id);

// 生效前的快照：只含这条链路和它的两端设备
export function makeSnapshot(d, edge) {
  return {
    edge: clone(edge),
    endpoints: [edge.source, edge.target]
      .map((id) => nodeByIdIn(d, id))
      .filter(Boolean)
      .map(clone),
  };
}

export function applyChange(d, c) {
  const edge = d.edges.find((e) => e.id === c.edgeId);
  if (!edge) return d;
  if (c.kind === 'disconnect') {
    return { ...d, edges: d.edges.filter((e) => e.id !== edge.id) };
  }
  if (c.kind === 'reconnect') {
    return {
      ...d,
      edges: d.edges.map((e) =>
        e.id === edge.id ? { ...e, [c.payload.which]: c.payload.nodeId } : e
      ),
    };
  }
  return d;
}

/* 扫描所有挂起变更：
   - 目标链路已消失 → 拒绝
   - 该链路当前有进行中的检修窗口 → 先生快照再应用
   - 其余继续挂起
   fired: [{changeId,label,result:'applied'|'rejected'}] */
export function processDue(d0, changes0, windows, ts) {
  let d = d0;
  let changes = changes0;
  const fired = [];

  for (const c of changes.filter((x) => x.status === 'held')) {
    const edge = d.edges.find((e) => e.id === c.edgeId);
    if (!edge) {
      changes = changes.map((x) =>
        x.id === c.id
          ? { ...x, status: 'rejected', rejectReason: '目标链路已不存在，变更无法生效' }
          : x
      );
      fired.push({ changeId: c.id, label: c.label, result: 'rejected' });
      continue;
    }
    if (!windows.some((w) => w.edgeId === c.edgeId && windowActive(w, ts))) continue;

    const snapshot = makeSnapshot(d0, edge);
    d = applyChange(d, c);
    changes = changes.map((x) =>
      x.id === c.id ? { ...x, status: 'applied', appliedAt: ts, snapshot } : x
    );
    fired.push({ changeId: c.id, label: c.label, result: 'applied' });
  }
  return { data: d, changes, fired };
}

/* 冲突仲裁：同一链路同时只能有一个挂起变更。
   返回 {changes, accepted}。低优先级一方（含优先级相同的后来者）被拒绝。 */
export function resolveConflict(changes, incoming) {
  const existing = changes.find((c) => c.edgeId === incoming.edgeId && c.status === 'held');
  if (!existing) return { changes: [...changes, incoming], accepted: true, displaced: null };

  if (incoming.priority > existing.priority) {
    return {
      changes: [
        ...changes.map((c) =>
          c.id === existing.id
            ? {
                ...c,
                status: 'rejected',
                rejectReason: `冲突：与更高优先级变更 ${incoming.label}（优先级 ${PRIORITY[incoming.priority]}）同时作用于同一条链路，本变更优先级较低，已拒绝`,
              }
            : c
        ),
        incoming,
      ],
      accepted: true,
      displaced: existing,
    };
  }
  return {
    changes: [
      ...changes,
      {
        ...incoming,
        status: 'rejected',
        rejectReason: `冲突：变更 ${existing.label} 已挂起作用于同一条链路（优先级 ${PRIORITY[existing.priority]}，先到先得），本次变更优先级未高于对方，已拒绝`,
      },
    ],
    accepted: false,
    displaced: null,
  };
}

/* 一键回退：只把快照中的链路与两端设备 upsert 回拓扑，其余一律不动 */
export function rollbackInto(d, snapshot) {
  const nodes = d.nodes.map((n) => {
    const snap = snapshot.endpoints.find((s) => s.id === n.id);
    return snap ? clone(snap) : n;
  });
  for (const ep of snapshot.endpoints) {
    if (!nodes.some((n) => n.id === ep.id)) nodes.push(clone(ep));
  }
  const edges = d.edges.some((e) => e.id === snapshot.edge.id)
    ? d.edges.map((e) => (e.id === snapshot.edge.id ? clone(snapshot.edge) : e))
    : [...d.edges, clone(snapshot.edge)];
  return { nodes, edges };
}
