import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const STORAGE_KEY = 'netscape-topology-v2';

const seedNodes = [
  { id: 'gw', name: '核心路由器', type: 'router', x: 470, y: 220, ip: '10.0.0.1' },
  { id: 'sw1', name: '交换机 A', type: 'switch', x: 250, y: 370, ip: '10.0.1.1' },
  { id: 'sw2', name: '交换机 B', type: 'switch', x: 690, y: 370, ip: '10.0.2.1' },
  { id: 'web', name: 'Web Server', type: 'server', x: 100, y: 520, ip: '10.0.1.10' },
  { id: 'db', name: 'Database', type: 'server', x: 400, y: 550, ip: '10.0.1.20' },
  { id: 'user', name: '办公终端', type: 'device', x: 820, y: 530, ip: '10.0.2.22' },
];

const seedEdges = [
  ['gw', 'sw1'],
  ['gw', 'sw2'],
  ['sw1', 'web'],
  ['sw1', 'db'],
  ['sw2', 'user'],
];

const seedLinks = seedEdges.map(([a, b], index) => ({
  id: `link-${index + 1}`,
  a,
  b,
  name: `链路 ${index + 1}`,
  kind: index < 2 ? '10G 光纤' : '1G 双绞线',
  bandwidth: index < 2 ? '10 Gbps' : '1 Gbps',
  status: '运行中',
}));

const deviceIcon = type =>
  type === 'router' ? '◉' : type === 'switch' ? '▦' : type === 'server' ? '▣' : '▱';

const linkStatuses = ['运行中', '检修中', '降级运行', '停用'];
const linkKinds = ['10G 光纤', '1G 双绞线', '千兆光纤', '无线链路'];
const priorities = [
  { value: 1, label: 'P1 最低' },
  { value: 2, label: 'P2 低' },
  { value: 3, label: 'P3 普通' },
  { value: 4, label: 'P4 高' },
  { value: 5, label: 'P5 紧急' },
];

const statusText = {
  pending: '已挂起',
  effective: '已生效',
  rejected: '冲突拒绝',
  rolled_back: '已回退',
  expired: '已过期',
};

const clone = value => JSON.parse(JSON.stringify(value));
const pad = value => String(value).padStart(2, '0');

function dateTimeInput(value) {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(
    value.getHours()
  )}:${pad(value.getMinutes())}`;
}

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

function pickNode(node) {
  return {
    id: node.id,
    name: node.name,
    ip: node.ip,
    type: node.type,
    x: node.x,
    y: node.y,
  };
}

function pickLink(link) {
  return {
    a: link.a,
    b: link.b,
    name: link.name,
    kind: link.kind,
    bandwidth: link.bandwidth,
    status: link.status,
  };
}

function makeDraft(link, nodes) {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const endpointList = [link.a, link.b].map(id => nodes.find(node => node.id === id)).filter(Boolean);
  const endpoints = Object.fromEntries(endpointList.map(node => [node.id, pickNode(node)]));

  return {
    title: `${link.name} 检修变更`,
    priority: 3,
    start: dateTimeInput(start),
    end: dateTimeInput(end),
    link: pickLink(link),
    endpoints,
  };
}

function applyChange(state, change, now) {
  const liveLink = state.links.find(link => link.id === change.linkId);
  if (!liveLink) {
    return { ...change, status: 'rejected', reason: '目标链路不存在，变更无法生效' };
  }

  const liveIds = [liveLink.a, liveLink.b];
  const missing = liveIds.find(id => !state.nodes.some(node => node.id === id));
  if (missing) {
    return { ...change, status: 'rejected', reason: `端点设备 ${missing} 不存在，变更无法生效` };
  }

  // 生效前的自动快照：只包含本链路和当前两端设备。
  const snapshot = {
    linkId: liveLink.id,
    link: { ...liveLink },
    nodes: liveIds.map(id => ({ ...state.nodes.find(node => node.id === id) })),
    createdAt: now.toISOString(),
  };

  state.links = state.links.map(link =>
    link.id === change.linkId ? { ...link, ...change.patch.link } : link
  );

  const nodePatches = Object.fromEntries(change.patch.nodes.map(node => [node.id, node]));
  state.nodes = state.nodes.map(node =>
    nodePatches[node.id] ? { ...node, ...nodePatches[node.id] } : node
  );

  return {
    ...change,
    status: 'effective',
    effectiveAt: now.toISOString(),
    snapshot,
  };
}

function processWindows(input, now) {
  if (!input.changes.some(change => change.status === 'pending')) return input;

  const state = clone(input);
  let changed = false;

  state.changes = state.changes.map(change => {
    if (change.status !== 'pending') return change;

    const start = new Date(change.windowStart);
    const end = new Date(change.windowEnd);

    if (now >= start && now <= end) {
      changed = true;
      return applyChange(state, change, now);
    }

    if (now > end) {
      changed = true;
      return {
        ...change,
        status: 'expired',
        reason: '检修窗口已结束，挂起变更未在窗口内生效',
      };
    }

    return change;
  });

  return changed ? state : input;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved?.nodes?.length && saved.links?.length) {
      return {
        nodes: saved.nodes,
        links: saved.links,
        changes: saved.changes || [],
        mode: saved.mode || 'ops',
      };
    }
  } catch {
    // 损坏的缓存不影响默认拓扑。
  }

  try {
    const old = JSON.parse(localStorage.getItem('topology') || 'null');
    if (old?.nodes) {
      return {
        nodes: old.nodes,
        links:
          old.links?.length
            ? old.links
            : (old.edges || []).map(([a, b], index) => ({
                id: `link-${index + 1}`,
                a,
                b,
                name: `链路 ${index + 1}`,
                kind: '1G 双绞线',
                bandwidth: '1 Gbps',
                status: '运行中',
              })),
        changes: [],
        mode: 'ops',
      };
    }
  } catch {
    // 忽略旧版本缓存。
  }

  return { nodes: seedNodes, links: seedLinks, changes: [], mode: 'ops' };
}

function App() {
  const [data, setData] = useState(() => processWindows(loadState(), new Date()));
  const [selection, setSelection] = useState({ type: 'node', id: 'gw' });
  const [draft, setDraft] = useState(() => makeDraft(seedLinks[0], seedNodes));
  const [drag, setDrag] = useState(null);
  const [notice, setNotice] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const [mockNow, setMockNow] = useState(null);
  const boardRef = useRef(null);
  const previousChangesRef = useRef(data.changes);

  const currentTime = mockNow ? new Date(mockNow) : new Date(clock);
  const isOps = data.mode === 'ops';

  const selectedNode = selection.type === 'node'
    ? data.nodes.find(node => node.id === selection.id)
    : null;
  const selectedLink = selection.type === 'link'
    ? data.links.find(link => link.id === selection.id)
    : null;

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  useEffect(() => {
    if (!mockNow) setData(prev => processWindows(prev, new Date(clock)));
  }, [clock, mockNow]);

  useEffect(() => {
    if (mockNow) setData(prev => processWindows(prev, new Date(mockNow)));
  }, [mockNow]);

  useEffect(() => {
    const previous = new Map(previousChangesRef.current.map(change => [change.id, change.status]));
    const activated = data.changes.find(
      change => change.status === 'effective' && previous.get(change.id) === 'pending'
    );
    if (activated) {
      setNotice({
        type: 'success',
        text: `到达检修窗口，${activated.id} 已生效；生效前快照已自动保存`,
      });
    }
    previousChangesRef.current = data.changes;
  }, [data.changes]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (selection.type === 'link') {
      const link = data.links.find(item => item.id === selection.id);
      if (link) setDraft(makeDraft(link, data.nodes));
    }
    // 仅切换选中链路时重置表单；生效后保留表单便于查看本次申请内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.type, selection.id]);

  const notify = (text, type = 'success') => setNotice({ text, type });
  const selectNode = id => setSelection({ type: 'node', id });
  const selectLink = id => setSelection({ type: 'link', id });

  const pendingByLink = useMemo(
    () =>
      new Map(
        data.changes
          .filter(change => change.status === 'pending')
          .map(change => [change.linkId, change])
      ),
    [data.changes]
  );

  const pendingNodeIds = useMemo(() => {
    const ids = new Set();
    pendingByLink.forEach((change, linkId) => {
      const link = data.links.find(item => item.id === linkId);
      if (link) {
        ids.add(link.a);
        ids.add(link.b);
      }
      change.patch.nodes.forEach(node => ids.add(node.id));
    });
    return ids;
  }, [data.links, pendingByLink]);

  const updateNode = (key, value) => {
    if (isOps) {
      notify('运行检修态不能直接改设备，请在链路变更单中申请', 'error');
      return;
    }
    setData(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => (node.id === selectedNode.id ? { ...node, [key]: value } : node)),
    }));
  };

  const addNode = (type = 'device', label = '新设备') => {
    if (isOps) {
      notify('拓扑已进入运行检修态，请先切回拓扑设计模式再新增设备', 'error');
      return;
    }
    const id = `node-${Date.now()}`;
    const node = { id, name: label, type, x: 500, y: 300, ip: '192.168.0.10' };
    setData(prev => ({ ...prev, nodes: [...prev.nodes, node] }));
    setSelection({ type: 'node', id });
    notify('已添加设备');
  };

  const connect = () => {
    if (!selectedNode) return;
    if (isOps) {
      notify('运行检修态不能直接新建链路，请先切回拓扑设计模式', 'error');
      return;
    }
    const other = prompt('输入要连接的设备 ID（例如 sw1）');
    if (!other) return;
    if (!data.nodes.some(node => node.id === other)) {
      notify('设备 ID 不存在', 'error');
      return;
    }
    if (other === selectedNode.id) {
      notify('不能把设备连接到自身', 'error');
      return;
    }
    const exists = data.links.some(
      link =>
        (link.a === selectedNode.id && link.b === other) ||
        (link.b === selectedNode.id && link.a === other)
    );
    if (exists) {
      notify('两条设备之间已存在链路', 'error');
      return;
    }
    const id = `link-${Date.now()}`;
    setData(prev => ({
      ...prev,
      links: [
        ...prev.links,
        {
          id,
          a: selectedNode.id,
          b: other,
          name: '新链路',
          kind: '1G 双绞线',
          bandwidth: '1 Gbps',
          status: '运行中',
        },
      ],
    }));
    selectLink(id);
    notify('连接已创建');
  };

  const removeNode = () => {
    if (!selectedNode) return;
    if (isOps) {
      notify('运行检修态不能直接删除设备，请通过链路变更流程处理', 'error');
      return;
    }
    const remaining = data.nodes.filter(node => node.id !== selectedNode.id);
    setData(prev => ({
      ...prev,
      nodes: remaining,
      links: prev.links.filter(link => link.a !== selectedNode.id && link.b !== selectedNode.id),
    }));
    setSelection({ type: 'node', id: remaining[0]?.id });
    notify('设备及相关连接已删除');
  };

  const moveNode = event => {
    if (!drag || isOps) return;
    const rect = boardRef.current.getBoundingClientRect();
    const x = Math.max(35, event.clientX - rect.left);
    const y = Math.max(35, event.clientY - rect.top);
    setData(prev => ({
      ...prev,
      nodes: prev.nodes.map(node => (node.id === drag ? { ...node, x, y } : node)),
    }));
  };

  const chooseDraftEndpoint = (side, id) => {
    const node = data.nodes.find(item => item.id === id);
    if (!node) return;
    setDraft(prev => ({
      ...prev,
      link: { ...prev.link, [side]: id },
      endpoints: { ...prev.endpoints, [id]: pickNode(node) },
    }));
  };

  const patchDraftEndpoint = (id, key, value) => {
    setDraft(prev => ({
      ...prev,
      endpoints: {
        ...prev.endpoints,
        [id]: { ...prev.endpoints[id], [key]: value },
      },
    }));
  };

  const submitChange = () => {
    if (!selectedLink) return;

    const start = new Date(draft.start);
    const end = new Date(draft.end);
    const title = draft.title.trim();

    if (!title) return notify('请填写变更标题', 'error');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return notify('请填写完整的检修窗口', 'error');
    }
    if (end <= start) return notify('窗口结束时间必须晚于开始时间', 'error');
    if (end <= currentTime) return notify('检修窗口已经结束，请重新安排窗口', 'error');
    if (draft.link.a === draft.link.b) return notify('链路两端不能选择同一台设备', 'error');
    if (
      data.links.some(
        link =>
          link.id !== selectedLink.id &&
          ((link.a === draft.link.a && link.b === draft.link.b) ||
            (link.a === draft.link.b && link.b === draft.link.a))
      )
    ) {
      return notify('目标两端之间已经存在另一条链路', 'error');
    }

    const desiredIds = [draft.link.a, draft.link.b];
    if (desiredIds.some(id => !data.nodes.some(node => node.id === id))) {
      return notify('请选择有效的两端设备', 'error');
    }

    // 只有当前两端设备允许随本次变更调整；切换进来的新端点沿用其当前属性，
    // 这样回退范围始终能限定在链路和两端设备内。
    const currentEndIds = [selectedLink.a, selectedLink.b];
    const patchNodes = desiredIds.map(id => {
      if (currentEndIds.includes(id)) return { ...draft.endpoints[id] };
      return pickNode(data.nodes.find(node => node.id === id));
    });

    const patch = {
      link: { ...draft.link },
      nodes: patchNodes,
    };

    const currentScoped = {
      link: pickLink(selectedLink),
      nodes: [selectedLink.a, selectedLink.b].map(
        id => pickNode(data.nodes.find(node => node.id === id))
      ),
    };
    const desiredScoped = { link: patch.link, nodes: patch.nodes };
    if (JSON.stringify(currentScoped) === JSON.stringify(desiredScoped)) {
      return notify('没有检测到链路或两端设备差异，无需提交变更', 'error');
    }

    const id = `CHG-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
    const willApply = currentTime >= start && currentTime <= end;
    let lowerRejected = false;
    let rejected = false;

    setData(prev => {
      const next = clone(prev);
      const existing = next.changes.find(
        change => change.linkId === selectedLink.id && change.status === 'pending'
      );

      const record = {
        id,
        linkId: selectedLink.id,
        title,
        priority: draft.priority,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        createdAt: currentTime.toISOString(),
        status: 'pending',
        patch,
      };

      if (existing) {
        // 同一条链路只允许一个挂起变更；低优先级直接落为 rejected，绝不覆盖原单。
        if (existing.priority >= draft.priority) {
          record.status = 'rejected';
          record.reason = `与已挂起变更 ${existing.id} 冲突：P${existing.priority} 优先级不低于 P${draft.priority}，本次变更被拒绝`;
          rejected = true;
        } else {
          existing.status = 'rejected';
          existing.reason = `与更高优先级变更 ${id} 冲突：P${draft.priority} 高于 P${existing.priority}，原变更被拒绝`;
          lowerRejected = true;
        }
      }

      next.changes.push(record);
      return processWindows(next, currentTime);
    });

    if (rejected) {
      notify(`变更冲突，${id} 已拒绝，原挂起变更保持不变`, 'error');
    } else if (willApply) {
      notify(
        `${lowerRejected ? '低优先级变更已拒绝；' : ''}当前位于窗口内，${id} 已生效，生效前快照已保存`,
        'success'
      );
    } else {
      notify(
        `${lowerRejected ? '低优先级变更已拒绝；' : ''}${id} 已挂起，将在 ${formatTime(
          start.toISOString()
        )} 自动生效`,
        'success'
      );
    }
  };

  const rollback = change => {
    if (change.status !== 'effective' || !change.snapshot) return;

    setData(prev => {
      const snapshotNodeMap = new Map(change.snapshot.nodes.map(node => [node.id, node]));
      const retainedNodes = prev.nodes.filter(node => !snapshotNodeMap.has(node.id));
      const restoredNodes = [...retainedNodes, ...change.snapshot.nodes.map(node => ({ ...node }))];

      const retainedLinks = prev.links.filter(link => link.id !== change.snapshot.link.id);
      const restoredLinks = [...retainedLinks, { ...change.snapshot.link }];

      return {
        ...prev,
        nodes: restoredNodes,
        links: restoredLinks,
        changes: prev.changes.map(item =>
          item.id === change.id
            ? { ...item, status: 'rolled_back', rolledBackAt: new Date().toISOString() }
            : item
        ),
      };
    });

    const names = change.snapshot.nodes.map(node => node.name).join('、');
    notify(`已按快照回退 ${change.id}：仅恢复该链路和 ${names}，其他设备与连接保持不变`, 'success');
  };

  const arriveAtWindow = change => {
    setMockNow(new Date(change.windowStart).getTime());
    notify(`模拟时钟已推进到窗口开始：${formatTime(change.windowStart)}`, 'success');
  };

  const validate = () => {
    const linked = new Set(data.links.flatMap(link => [link.a, link.b]));
    const isolated = data.nodes.filter(node => !linked.has(node.id));
    notify(
      isolated.length ? `发现 ${isolated.length} 个孤立节点` : '拓扑检查通过：没有孤立节点',
      isolated.length ? 'error' : 'success'
    );
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ nodes: data.nodes, links: data.links, changes: data.changes }, null, 2)], {
      type: 'application/json',
    });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = 'network-topology.json';
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    notify('JSON 已导出');
  };

  const linkChanges = selectedLink
    ? data.changes
        .filter(change => change.linkId === selectedLink.id)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    : [];
  const latestEffectiveId = linkChanges
    .filter(change => change.status === 'effective')
    .sort((a, b) => new Date(b.effectiveAt) - new Date(a.effectiveAt))[0]?.id;

  const queueChanges = data.changes
    .filter(change => ['pending', 'rejected', 'effective'].includes(change.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);

  const nodeLinks = id => data.links.filter(link => link.a === id || link.b === id);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">⌁</span>
          <div>
            <strong>NETSCAPE</strong>
            <small>CHANGE MAINTENANCE</small>
          </div>
        </div>
        <div className="file">
          <span className={`dot ${isOps ? 'ops' : 'design'}`}></span>
          <div>
            <strong>office-network.json</strong>
            <small>{isOps ? '运行检修态' : '拓扑设计态'}</small>
          </div>
        </div>
        <div className="top-actions">
          <button
            className="mode-toggle"
            onClick={() => setData(prev => ({ ...prev, mode: isOps ? 'design' : 'ops' }))}
          >
            {isOps ? '切换到设计模式' : '切换到检修模式'}
          </button>
          <button onClick={validate}>✓ 检查</button>
          <button onClick={exportJson}>↓ 导出</button>
          <button className="save" onClick={() => notify('所有拓扑、窗口和快照均已自动保存')}>
            保存更改
          </button>
        </div>
      </header>

      <div className="toolbar">
        <div className="tool-group">
          <span>工具</span>
          <button className="on">↖ 选择</button>
          <button disabled={isOps} onClick={connect}>⌁ 连接</button>
          <button disabled={isOps} onClick={() => addNode()}>＋ 设备</button>
        </div>
        <div className="tool-group zoom">
          <button>−</button>
          <span>100%</span>
          <button>＋</button>
          <button onClick={() => notify('画布已居中')}>⌗</button>
        </div>
      </div>

      <div className="workspace">
        <aside className="inventory">
          <div className="section-title">
            <span>设备库</span>
            <small>{data.nodes.length} 个节点</small>
          </div>
          <div className="device-types">
            {[
              ['router', '◉', '路由器'],
              ['switch', '▦', '交换机'],
              ['server', '▣', '服务器'],
              ['device', '▱', '终端设备'],
            ].map(([type, icon, label]) => (
              <button key={type} disabled={isOps} onClick={() => addNode(type, label)}>
                <i className={type}>{icon}</i>
                {label}
                <span>＋</span>
              </button>
            ))}
          </div>

          <div className="section-title nodes-head">
            <span>图中节点</span>
            <small>点击查看</small>
          </div>
          <div className="node-list">
            {data.nodes.map(node => (
              <button
                key={node.id}
                className={selectedNode?.id === node.id ? 'sel' : ''}
                onClick={() => selectNode(node.id)}
              >
                <i className={node.type}>{deviceIcon(node.type)}</i>
                <span>
                  <strong>{node.name}</strong>
                  <small>{node.ip}</small>
                </span>
                {pendingNodeIds.has(node.id) && <em className="pending-dot">窗</em>}
                <b>›</b>
              </button>
            ))}
          </div>
        </aside>

        <section className="canvas-wrap">
          <div className="canvas" ref={boardRef} onMouseMove={moveNode} onMouseUp={() => setDrag(null)}>
            <div className="ops-panel">
              <div className="ops-panel-head">
                <div>
                  <strong>变更队列</strong>
                  <small>
                    {mockNow ? '模拟时钟' : '实时时钟'} {formatTime(currentTime.toISOString())}
                  </small>
                </div>
                {mockNow && (
                  <button onClick={() => { setMockNow(null); setData(prev => processWindows(prev, new Date())); }}>
                    回到实时
                  </button>
                )}
              </div>
              <div className="queue-list">
                {queueChanges.length === 0 && <p className="empty">暂无挂起或冲突变更</p>}
                {queueChanges.map(change => {
                  const link = data.links.find(item => item.id === change.linkId);
                  return (
                    <div
                      key={change.id}
                      className={`queue-row ${change.status}`}
                      onClick={() => selectLink(change.linkId)}
                    >
                      <div>
                        <strong>{change.id}</strong>
                        <small>{link?.name || '已删除链路'} · {change.title}</small>
                        {change.reason && <em>{change.reason}</em>}
                      </div>
                      <span className={`priority priority-${change.priority}`}>P{change.priority}</span>
                      <span className={`status ${change.status}`}>{statusText[change.status]}</span>
                      {change.status === 'pending' && (
                        <button
                          className="mini-button"
                          title="模拟到达窗口开始时间"
                          onClick={event => {
                            event.stopPropagation();
                            arriveAtWindow(change);
                          }}
                        >
                          到点
                        </button>
                      )}
                      {change.status === 'effective' && Boolean(change.snapshot) && (
                        <span className="snapshot-mark" title="生效前已自动快照">快照</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {data.links.map(link => {
              const a = data.nodes.find(node => node.id === link.a);
              const b = data.nodes.find(node => node.id === link.b);
              if (!a || !b) return null;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const length = Math.hypot(dx, dy);
              const angle = Math.atan2(dy, dx) * 180 / Math.PI;
              const pending = pendingByLink.get(link.id);
              const selected = selectedLink?.id === link.id;

              return (
                <React.Fragment key={link.id}>
                  <button
                    className={`edge ${selected ? 'selected' : ''} ${pending ? 'pending' : ''}`}
                    style={{
                      left: a.x,
                      top: a.y - 7,
                      width: length,
                      transform: `rotate(${angle}deg)`,
                    }}
                    onClick={() => selectLink(link.id)}
                  >
                    <span className="edge-line"></span>
                    <span className="edge-arrow"></span>
                  </button>
                  <button
                    className={`edge-tag ${selected ? 'selected' : ''} ${pending ? 'pending' : ''}`}
                    style={{ left: (a.x + b.x) / 2, top: (a.y + b.y) / 2 }}
                    onClick={() => selectLink(link.id)}
                  >
                    {link.name}
                    {pending && <i>●</i>}
                  </button>
                </React.Fragment>
              );
            })}

            {data.nodes.map(node => (
              <button
                key={node.id}
                className={[
                  'node',
                  node.type,
                  selectedNode?.id === node.id ? 'picked' : '',
                  pendingNodeIds.has(node.id) ? 'has-pending' : '',
                ].join(' ')}
                style={{ left: node.x - 42, top: node.y - 31 }}
                onMouseDown={event => {
                  event.stopPropagation();
                  selectNode(node.id);
                  if (!isOps) setDrag(node.id);
                }}
                onClick={() => selectNode(node.id)}
              >
                <i>{deviceIcon(node.type)}</i>
                <strong>{node.name}</strong>
                <small>{node.ip}</small>
              </button>
            ))}

            <div className="legend">
              <span><i className="router"></i>路由器</span>
              <span><i className="switch"></i>交换机</span>
              <span><i className="server"></i>服务器</span>
            </div>
          </div>
          <div className="canvas-footer">
            <span>
              {isOps ? '运行检修态：点击链路安排窗口和提交变更' : '设计模式：拖动节点调整位置'} · {data.links.length} 条连接
            </span>
            <span>{pendingByLink.size} 个变更等待窗口</span>
          </div>
        </section>

        <aside className="inspector">
          {selectedNode && (
            <>
              <div className="section-title">
                <span>设备属性</span>
                <small>{selectedNode.type}</small>
              </div>
              <label>
                设备名称
                <input
                  value={selectedNode.name}
                  readOnly={isOps}
                  onChange={event => updateNode('name', event.target.value)}
                />
              </label>
              <label>
                IP 地址
                <input
                  value={selectedNode.ip}
                  readOnly={isOps}
                  onChange={event => updateNode('ip', event.target.value)}
                />
              </label>
              <label>
                设备类型
                <select
                  value={selectedNode.type}
                  disabled={isOps}
                  onChange={event => updateNode('type', event.target.value)}
                >
                  <option value="router">路由器</option>
                  <option value="switch">交换机</option>
                  <option value="server">服务器</option>
                  <option value="device">终端设备</option>
                </select>
              </label>
              <div className="inspector-actions">
                <button disabled={isOps} onClick={connect}>⌁ 添加连接</button>
                <button className="danger" disabled={isOps} onClick={removeNode}>删除设备</button>
              </div>
              {isOps && <p className="hint">设备属性和位置已冻结，请选择一条链路提交检修变更。</p>}

              <div className="connections">
                <div className="section-title">
                  <span>连接</span>
                  <small>{nodeLinks(selectedNode.id).length} 条</small>
                </div>
                {nodeLinks(selectedNode.id).map(link => {
                  const otherId = link.a === selectedNode.id ? link.b : link.a;
                  const other = data.nodes.find(node => node.id === otherId);
                  return (
                    <button key={link.id} className="connection" onClick={() => selectLink(link.id)}>
                      <span className={`mini ${other?.type}`}></span>
                      <strong>{other?.name}</strong>
                      <small>{pendingByLink.has(link.id) ? '待窗口' : '在线'}</small>
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {selectedLink && (
            <>
              <div className="section-title">
                <span>链路检修</span>
                <small>{selectedLink.id}</small>
              </div>

              <div className="current-card">
                <strong>{selectedLink.name}</strong>
                <p>
                  {data.nodes.find(node => node.id === selectedLink.a)?.name}
                  {' ↔ '}
                  {data.nodes.find(node => node.id === selectedLink.b)?.name}
                </p>
                <div className="current-meta">
                  <span>{selectedLink.kind}</span>
                  <span>{selectedLink.bandwidth}</span>
                  <span>{selectedLink.status}</span>
                </div>
              </div>

              {!isOps && (
                <p className="hint">当前为拓扑设计模式。切换到运行检修态后可安排窗口、提交变更。</p>
              )}

              <fieldset className="change-form" disabled={!isOps}>
                <legend>变更申请</legend>
                <label>
                  变更标题
                  <input
                    value={draft.title}
                    onChange={event => setDraft(prev => ({ ...prev, title: event.target.value }))}
                  />
                </label>
                <label>
                  优先级（数值越高越优先）
                  <select
                    value={draft.priority}
                    onChange={event =>
                      setDraft(prev => ({ ...prev, priority: Number(event.target.value) }))
                    }
                  >
                    {priorities.map(item => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <div className="form-grid">
                  <label>
                    窗口开始
                    <input
                      type="datetime-local"
                      value={draft.start}
                      onChange={event => setDraft(prev => ({ ...prev, start: event.target.value }))}
                    />
                  </label>
                  <label>
                    窗口结束
                    <input
                      type="datetime-local"
                      value={draft.end}
                      onChange={event => setDraft(prev => ({ ...prev, end: event.target.value }))}
                    />
                  </label>
                </div>

                <label>
                  链路名称
                  <input
                    value={draft.link.name}
                    onChange={event =>
                      setDraft(prev => ({ ...prev, link: { ...prev.link, name: event.target.value } }))
                    }
                  />
                </label>
                <div className="form-grid">
                  <label>
                    链路类型
                    <select
                      value={draft.link.kind}
                      onChange={event =>
                        setDraft(prev => ({ ...prev, link: { ...prev.link, kind: event.target.value } }))
                      }
                    >
                      {linkKinds.map(kind => <option key={kind}>{kind}</option>)}
                    </select>
                  </label>
                  <label>
                    带宽
                    <input
                      value={draft.link.bandwidth}
                      onChange={event =>
                        setDraft(prev => ({
                          ...prev,
                          link: { ...prev.link, bandwidth: event.target.value },
                        }))
                      }
                    />
                  </label>
                </div>
                <label>
                  运行状态
                  <select
                    value={draft.link.status}
                    onChange={event =>
                      setDraft(prev => ({ ...prev, link: { ...prev.link, status: event.target.value } }))
                    }
                  >
                    {linkStatuses.map(status => <option key={status}>{status}</option>)}
                  </select>
                </label>

                {['a', 'b'].map(side => {
                  const endpointId = draft.link[side];
                  const endpoint = draft.endpoints[endpointId];
                  const canEditEndpoint =
                    selectedLink && [selectedLink.a, selectedLink.b].includes(endpointId);
                  return (
                    <div className="endpoint-card" key={side}>
                      <strong>{side === 'a' ? 'A 端设备' : 'B 端设备'}</strong>
                      <select value={endpointId} onChange={event => chooseDraftEndpoint(side, event.target.value)}>
                        {data.nodes.map(node => (
                          <option key={node.id} value={node.id}>{node.name}（{node.id}）</option>
                        ))}
                      </select>
                      {!canEditEndpoint && (
                        <small className="endpoint-note">切换后的新端点沿用当前属性，仅由本次改接影响连接关系</small>
                      )}
                      {endpoint && (
                        <>
                          <input
                            value={endpoint.name}
                            readOnly={!canEditEndpoint}
                            placeholder="设备名称"
                            onChange={event => canEditEndpoint && patchDraftEndpoint(endpoint.id, 'name', event.target.value)}
                          />
                          <input
                            value={endpoint.ip}
                            readOnly={!canEditEndpoint}
                            placeholder="IP 地址"
                            onChange={event => canEditEndpoint && patchDraftEndpoint(endpoint.id, 'ip', event.target.value)}
                          />
                          <select
                            value={endpoint.type}
                            disabled={!canEditEndpoint}
                            onChange={event => canEditEndpoint && patchDraftEndpoint(endpoint.id, 'type', event.target.value)}
                          >
                            <option value="router">路由器</option>
                            <option value="switch">交换机</option>
                            <option value="server">服务器</option>
                            <option value="device">终端设备</option>
                          </select>
                          <div className="form-grid">
                            <input
                              type="number"
                              value={endpoint.x}
                              readOnly={!canEditEndpoint}
                              aria-label="X 坐标"
                              onChange={event =>
                                canEditEndpoint &&
                                patchDraftEndpoint(endpoint.id, 'x', Number(event.target.value) || 0)
                              }
                            />
                            <input
                              type="number"
                              value={endpoint.y}
                              readOnly={!canEditEndpoint}
                              aria-label="Y 坐标"
                              onChange={event =>
                                canEditEndpoint &&
                                patchDraftEndpoint(endpoint.id, 'y', Number(event.target.value) || 0)
                              }
                            />
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                <button className="submit-change" onClick={submitChange}>提交变更</button>
                <p className="hint">窗口外提交只会挂起；同链路已有挂起变更时，低优先级会被拒绝。</p>
              </fieldset>

              <div className="history">
                <div className="section-title">
                  <span>生效与快照</span>
                  <small>{linkChanges.length} 条记录</small>
                </div>
                {linkChanges.length === 0 && <p className="empty">暂无变更记录</p>}
                {linkChanges.map(change => (
                  <div key={change.id} className={`change-card ${change.status}`}>
                    <div>
                      <strong>{change.id}</strong>
                      <span className={`status ${change.status}`}>{statusText[change.status]}</span>
                    </div>
                    <p>{change.title}</p>
                    <small>
                      P{change.priority} · 窗口 {formatTime(change.windowStart)} - {formatTime(change.windowEnd)}
                    </small>
                    {change.reason && <em className="reason">{change.reason}</em>}
                    {change.snapshot && (
                      <div className="snapshot">
                        <span>
                          自动快照：{change.snapshot.nodes.map(node => node.name).join('、')}
                        </span>
                        <small>{formatTime(change.snapshot.createdAt)} 生效前保存</small>
                      </div>
                    )}
                    {change.status === 'pending' && (
                      <button className="mini-button" onClick={() => arriveAtWindow(change)}>
                        模拟到达窗口
                      </button>
                    )}
                    {change.status === 'effective' && (
                      <button
                        className="rollback"
                        disabled={latestEffectiveId !== change.id}
                        title={
                          latestEffectiveId !== change.id
                            ? '请先回退后续生效的变更'
                            : '一键恢复该链路和两端设备'
                        }
                        onClick={() => rollback(change)}
                      >
                        一键回退
                      </button>
                    )}
                    {change.status === 'rolled_back' && (
                      <small className="rolled-back">已于 {formatTime(change.rolledBackAt)} 回退</small>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {!selectedNode && !selectedLink && <p className="empty">请选择设备或链路</p>}
        </aside>
      </div>

      {notice && <div className={`toast ${notice.type}`}>{notice.text}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
