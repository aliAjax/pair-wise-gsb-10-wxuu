import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './changes.css';
import {
  migrate, clone, uid, PRIORITY, windowActive, windowStatus,
  processDue, resolveConflict, rollbackInto,
} from './engine';

/* ------------------------------------------------------------------ */
/* 数据模型                                                            */
/* ------------------------------------------------------------------ */
// topology: { nodes:[{id,name,type,x,y,ip}], edges:[{id,source,target}] }
// windows:  [{id, edgeId, start, end}]                 检修窗口（按链路）
// changes:  变更单，status: held 挂起 / applied 已生效 /
//                        rejected 已拒绝 / rolled_back 已回退
//   生效前写入 snapshot = { edge, endpoints:[node,node] }
//   回退时只恢复 snapshot 里的这条边和两个端点，其余设备/连线照旧

const seed = {
  nodes: [
    { id: 'gw',   name: '核心路由器', type: 'router', x: 470, y: 220, ip: '10.0.0.1' },
    { id: 'sw1',  name: '交换机 A',  type: 'switch', x: 250, y: 370, ip: '10.0.1.1' },
    { id: 'sw2',  name: '交换机 B',  type: 'switch', x: 690, y: 370, ip: '10.0.2.1' },
    { id: 'web',  name: 'Web Server', type: 'server', x: 100, y: 520, ip: '10.0.1.10' },
    { id: 'db',   name: 'Database',  type: 'server', x: 400, y: 550, ip: '10.0.1.20' },
    { id: 'user', name: '办公终端',   type: 'device', x: 820, y: 530, ip: '10.0.2.22' },
  ],
  edges: [
    { id: 'e-gw-sw1',  source: 'gw',  target: 'sw1' },
    { id: 'e-gw-sw2',  source: 'gw',  target: 'sw2' },
    { id: 'e-sw1-web', source: 'sw1', target: 'web' },
    { id: 'e-sw1-db',  source: 'sw1', target: 'db' },
    { id: 'e-sw2-user', source: 'sw2', target: 'user' },
  ],
};

/* ------------------------------------------------------------------ */
/* 时间辅助                                                            */
/* ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (t) => {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const toLocalInput = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const loadTopology = () => {
  try { return migrate(JSON.parse(localStorage.getItem('topology')) || seed); }
  catch { return clone(seed); }
};
const loadList = (key) => {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
};

/* ------------------------------------------------------------------ */
/* 主应用                                                              */
/* ------------------------------------------------------------------ */
function App() {
  const [data, setData] = useState(loadTopology);
  const [windows, setWindows] = useState(() => loadList('windows'));
  const [changes, setChanges] = useState(() => loadList('changes'));
  const [selected, setSelected] = useState('gw');
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [tool, setTool] = useState('select');
  const [notice, setNotice] = useState(null); // {text, kind}
  const [drag, setDrag] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const board = useRef();

  useEffect(() => localStorage.setItem('topology', JSON.stringify(data)), [data]);
  useEffect(() => localStorage.setItem('windows', JSON.stringify(windows)), [windows]);
  useEffect(() => localStorage.setItem('changes', JSON.stringify(changes)), [changes]);

  const toast = (text, kind = 'ok') => setNotice({ text, kind });

  // 最新状态的 ref，供定时器读取
  const stateRef = useRef({});
  stateRef.current = { data, changes, windows };

  const nodeById = (id) => data.nodes.find((n) => n.id === id);
  const edgeName = (e) =>
    e ? `${nodeById(e.source)?.name ?? e.source} ↔ ${nodeById(e.target)?.name ?? e.target}` : '已删除链路';

  /* ---------------- 生效引擎：挂起 → 到窗口自动生效 ---------------- */
  const runDue = (ts = Date.now()) => {
    const { data: nd, changes: nc, fired } = processDue(data, changes, windows, ts);
    if (fired.length) {
      setData(nd); setChanges(nc); setNow(ts);
      const bad = fired.find((f) => f.result === 'rejected');
      toast(bad
        ? `变更 ${bad.label}：目标链路已不存在，已拒绝`
        : `检修窗口已到，${fired.map((f) => f.label).join('、')} 已生效（已自动留存快照）`);
    } else {
      toast('暂无到达检修窗口的挂起变更');
    }
  };

  // 轮询：到窗口自动生效
  useEffect(() => {
    const timer = setInterval(() => {
      const ts = Date.now();
      setNow(ts);
      const s = stateRef.current;
      const r = processDue(s.data, s.changes, s.windows, ts);
      if (r.fired.length) { setData(r.data); setChanges(r.changes); }
    }, 1500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- 提交变更（含冲突仲裁） ---------------- */
  const submitChange = ({ edgeId, kind, priority, payload }) => {
    const edge = data.edges.find((e) => e.id === edgeId);
    if (!edge) return toast('请选择一条存在的链路', 'err');
    if (kind === 'reconnect') {
      if (!payload?.nodeId || [edge.source, edge.target].includes(payload.nodeId)) {
        return toast('请选择一个不同于当前两端的新设备', 'err');
      }
    }
    const seq = changes.reduce((m, c) => Math.max(m, c.seq), 1000);
    const label = `#${seq + 1}`;
    const base = {
      id: uid('chg'), seq: seq + 1, label, edgeId, kind, payload: payload || null,
      priority, createdAt: Date.now(), status: 'held',
    };

    // 同一链路同时只允许一个挂起变更：优先级低的一方被拒绝，绝不静默覆盖
    const { changes: next, accepted, displaced } = resolveConflict(changes, base);
    if (!accepted) {
      toast(`变更 ${label} 与挂起中的变更冲突，优先级不占优，已拒绝（未覆盖任何已有变更）`, 'err');
      setChanges(next);
      return;
    }
    if (displaced) {
      toast(`冲突仲裁：${displaced.label}（优先级 ${PRIORITY[displaced.priority]}）优先级较低，已拒绝；${label} 已进入挂起队列`, 'warn');
    }

    // 窗口内提交 → 立即生效；窗口外 → 挂起等待
    const r = processDue(data, next, windows, Date.now());
    setData(r.data);
    setChanges(r.changes);
    if (r.fired.some((f) => f.changeId === base.id && f.result === 'applied')) {
      toast(`当前正处于该链路检修窗口，变更 ${label} 已生效（已留存快照，可一键回退）`);
    } else if (!displaced) {
      toast(`变更 ${label} 已挂起，等待检修窗口开始后自动生效`);
    }
  };

  /* ---------------- 一键回退（只恢复该链路和两端设备） ---------------- */
  const rollback = (c) => {
    if (c.status !== 'applied' || !c.snapshot) return;
    setData((d) => rollbackInto(d, c.snapshot));
    setChanges((cs) => cs.map((x) => x.id === c.id ? { ...x, status: 'rolled_back', rolledBackAt: Date.now() } : x));
    toast(`已按快照回退：仅恢复 ${edgeName(c.snapshot.edge)} 及其两端设备，其他设备的位置和连接未改动`);
  };

  /* ---------------- 画布编辑（原有能力） ---------------- */
  const node = data.nodes.find((n) => n.id === selected) || data.nodes[0];
  const updateNode = (k, v) =>
    setData({ ...data, nodes: data.nodes.map((n) => (n.id === selected ? { ...n, [k]: v } : n)) });

  const addNodeOfType = (type, name) => {
    const id = 'node' + Date.now();
    setData({ ...data, nodes: [...data.nodes, { id, name: name || '新设备', type, x: 500, y: 320, ip: '192.168.0.2' }] });
    setSelected(id);
  };

  const connect = () => {
    if (!selected) return;
    const other = prompt('输入要连接的设备 ID（例如 sw1）');
    if (!other) return;
    if (!data.nodes.some((n) => n.id === other)) return toast('设备 ID 不存在', 'err');
    if (other === selected) return toast('不能连接设备自身', 'err');
    if (data.edges.some((e) =>
      (e.source === selected && e.target === other) || (e.target === selected && e.source === other))) {
      return toast('该连接已存在', 'err');
    }
    const id = `e-${[selected, other].sort().join('-')}`;
    setData({ ...data, edges: [...data.edges, { id, source: selected, target: other }] });
    setSelectedEdge(id);
    toast('连接已创建');
  };

  const remove = () => {
    setData({
      ...data,
      nodes: data.nodes.filter((n) => n.id !== selected),
      edges: data.edges.filter((e) => ! [e.source, e.target].includes(selected)),
    });
    setSelected(data.nodes.find((n) => n.id !== selected)?.id);
    toast('设备已删除');
  };

  const exportJson = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'network-topology.json';
    a.click();
    toast('JSON 已导出');
  };

  const validate = () => {
    const linked = new Set(data.edges.flatMap((e) => [e.source, e.target]));
    const isolated = data.nodes.filter((n) => !linked.has(n.id));
    toast(isolated.length ? `发现 ${isolated.length} 个孤立节点` : '拓扑检查通过：没有孤立节点',
      isolated.length ? 'warn' : 'ok');
  };

  const move = (e) => {
    if (!drag) return;
    const r = board.current.getBoundingClientRect();
    setData({
      ...data,
      nodes: data.nodes.map((n) => n.id === drag
        ? { ...n, x: Math.max(35, e.clientX - r.left), y: Math.max(35, e.clientY - r.top) } : n),
    });
  };

  // 每条边的当前状态标记（用于画布着色 / 徽标）
  const edgeState = (eid, ts) => {
    if (changes.some((c) => c.edgeId === eid && c.status === 'held')) return 'held';
    if (windows.some((w) => w.edgeId === eid && windowActive(w, ts))) return 'window';
    if (changes.some((c) => c.edgeId === eid && c.status === 'applied')) return 'applied';
    return null;
  };
  const heldCount = changes.filter((c) => c.status === 'held').length;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-mark">⌁</span>
          <div><strong>NETSCAPE</strong><small>TOPOLOGY STUDIO</small></div>
        </div>
        <div className="file">
          <span className="dot"></span>
          <div><strong>office-network.json</strong><small>当前时间：{fmtTime(now)}</small></div>
        </div>
        <div className="top-actions">
          <button onClick={validate}>✓ 检查</button>
          <button onClick={exportJson}>↓ 导出</button>
          <button className="mgmt-entry" onClick={() => setPanelOpen(true)}>
            🛠 变更管理{heldCount > 0 && <b className="queue-badge">{heldCount}</b>}
          </button>
          <button className="save" onClick={() => toast('拓扑图已保存')}>保存更改</button>
        </div>
      </header>

      <div className="toolbar">
        <div className="tool-group">
          <span>工具</span>
          <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}>↖ 选择</button>
          <button onClick={connect}>⌁ 连接</button>
          <button onClick={() => addNodeOfType('device', '新设备')}>＋ 设备</button>
        </div>
        <div className="tool-group zoom">
          <button onClick={() => runDue()}>⏱ 立即检查窗口</button>
          <span>挂起 {heldCount} 条 · 每 1.5s 自动检查</span>
        </div>
      </div>

      <div className="workspace">
        <aside className="inventory">
          <div className="section-title"><span>设备库</span><small>{data.nodes.length} 个节点</small></div>
          <div className="device-types">
            {[['router', '◉', '路由器'], ['switch', '▦', '交换机'], ['server', '▣', '服务器'], ['device', '▱', '终端设备']]
              .map(([t, i, l]) => (
                <button key={t} onClick={() => addNodeOfType(t, l)}>
                  <i className={t}>{i}</i>{l}<span>＋</span>
                </button>
              ))}
          </div>
          <div className="section-title nodes-head"><span>图中节点</span><small>点击查看</small></div>
          <div className="node-list">
            {data.nodes.map((n) => (
              <button key={n.id} className={selected === n.id ? 'sel' : ''} onClick={() => setSelected(n.id)}>
                <i className={n.type}>{n.type === 'router' ? '◉' : n.type === 'switch' ? '▦' : n.type === 'server' ? '▣' : '▱'}</i>
                <span><strong>{n.name}</strong><small>{n.ip}</small></span>
                <b>›</b>
              </button>
            ))}
          </div>
        </aside>

        <section className="canvas-wrap">
          <div className="canvas" ref={board}
            onMouseMove={move}
            onMouseUp={() => setDrag(null)}
            onClick={() => setSelectedEdge(null)}>
            {data.edges.map((e) => {
              const n1 = nodeById(e.source), n2 = nodeById(e.target);
              if (!n1 || !n2) return null;
              const dx = n2.x - n1.x, dy = n2.y - n1.y;
              const len = Math.hypot(dx, dy);
              const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
              const st = edgeState(e.id, now);
              return (
                <div key={e.id}
                  className={`edge ${st ? 'edge-' + st : ''}${selectedEdge === e.id ? ' edge-sel' : ''}`}
                  style={{ left: n1.x, top: n1.y, width: len, transform: `rotate(${ang}deg)` }}
                  onClick={(ev) => { ev.stopPropagation(); setSelectedEdge(e.id); }}>
                  <span className="arrow"></span>
                  {st && (
                    <em className="edge-tag" style={{ transform: `rotate(${-ang}deg)` }}>
                      {st === 'held' ? '挂起中' : st === 'window' ? '检修窗口' : '已生效'}
                    </em>
                  )}
                </div>
              );
            })}
            {data.nodes.map((n) => (
              <button key={n.id}
                className={'node ' + n.type + (selected === n.id ? ' picked' : '')}
                style={{ left: n.x - 42, top: n.y - 31 }}
                onMouseDown={(e) => { e.stopPropagation(); setSelected(n.id); setDrag(n.id); }}
                onClick={(e) => { e.stopPropagation(); setSelected(n.id); }}>
                <i>{n.type === 'router' ? '◉' : n.type === 'switch' ? '▦' : n.type === 'server' ? '▣' : '▱'}</i>
                <strong>{n.name}</strong>
                <small>{n.ip}</small>
              </button>
            ))}
            <div className="legend">
              <span><i className="router"></i>路由器</span>
              <span><i className="switch"></i>交换机</span>
              <span><i className="server"></i>服务器</span>
              <span className="lg-held">┄ 挂起</span>
              <span className="lg-window">─ 窗口</span>
            </div>
          </div>
          <div className="canvas-footer">
            <span>拖动节点调整位置 · 点击连线可提交变更 · {data.edges.length} 条连接</span>
            <span>坐标系：画布局部</span>
          </div>
        </section>

        <aside className="inspector">
          <div className="section-title"><span>属性</span><small>{node?.type}</small></div>
          {node ? (
            <>
              <label>设备名称<input value={node.name} onChange={(e) => updateNode('name', e.target.value)} /></label>
              <label>IP 地址<input value={node.ip} onChange={(e) => updateNode('ip', e.target.value)} /></label>
              <label>设备类型
                <select value={node.type} onChange={(e) => updateNode('type', e.target.value)}>
                  <option value="router">路由器</option>
                  <option value="switch">交换机</option>
                  <option value="server">服务器</option>
                  <option value="device">终端设备</option>
                </select>
              </label>
              <div className="inspector-actions">
                <button onClick={connect}>⌁ 添加连接</button>
                <button className="danger" onClick={remove}>删除设备</button>
              </div>
              <div className="connections">
                <div className="section-title">
                  <span>连接</span>
                  <small>{data.edges.filter((e) => [e.source, e.target].includes(node.id)).length} 条</small>
                </div>
                {data.edges.filter((e) => [e.source, e.target].includes(node.id)).map((e) => {
                  const otherId = e.source === node.id ? e.target : e.source;
                  const other = nodeById(otherId);
                  const st = edgeState(e.id, now);
                  return (
                    <div className="connection" key={e.id}>
                      <span className={'mini ' + other?.type}></span>
                      <strong>{other?.name ?? otherId}</strong>
                      {st === 'held' && <small className="c-held">挂起</small>}
                      {st === 'window' && <small>窗口中</small>}
                      {st !== 'held' && st !== 'window' && <small>在线</small>}
                      <button className="link-change-btn"
                        onClick={() => { setSelectedEdge(e.id); setPanelOpen(true); }}>变更</button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : <p>选择一个设备</p>}
        </aside>
      </div>

      {panelOpen && (
        <ChangePanel
          data={data} windows={windows} changes={changes} now={now}
          edgeId={selectedEdge} onPickEdge={setSelectedEdge}
          onClose={() => setPanelOpen(false)}
          onAddWindow={(w) => { setWindows((ws) => [...ws, w]); toast(`检修窗口已登记：${edgeName(data.edges.find((e) => e.id === w.edgeId))}，${fmtTime(w.start)} ~ ${fmtTime(w.end)}`); }}
          onRemoveWindow={(id) => setWindows((ws) => ws.filter((w) => w.id !== id))}
          onSubmit={submitChange}
          onRollback={rollback}
          onRunDue={runDue}
          edgeName={edgeName}
        />
      )}

      {notice && (
        <div className={'toast toast-' + notice.kind} onClick={() => setNotice(null)}>{notice.text}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 变更管理抽屉：检修窗口 + 变更队列                                    */
/* ------------------------------------------------------------------ */
function ChangePanel({
  data, windows, changes, now, edgeId, onPickEdge,
  onClose, onAddWindow, onRemoveWindow, onSubmit, onRollback, onRunDue, edgeName,
}) {
  const [wEdge, setWEdge] = useState(edgeId || data.edges[0]?.id);
  const [wStart, setWStart] = useState('');
  const [wEnd, setWEnd] = useState('');

  const [cEdge, setCEdge] = useState(edgeId || data.edges[0]?.id);
  const [cKind, setCKind] = useState('disconnect');
  const [cPriority, setCPriority] = useState(2);
  const [which, setWhich] = useState('target');
  const [newNode, setNewNode] = useState('');

  useEffect(() => { if (edgeId) { setWEdge(edgeId); setCEdge(edgeId); } }, [edgeId]);

  const preset = (minsAhead, durMins) => {
    const s = Date.now() + minsAhead * 60000;
    setWStart(toLocalInput(s));
    setWEnd(toLocalInput(s + durMins * 60000));
  };

  const addWindow = () => {
    const start = new Date(wStart).getTime();
    const end = new Date(wEnd).getTime();
    if (!wEdge || Number.isNaN(start) || Number.isNaN(end)) return;
    if (end <= start) { alert('窗口结束时间必须晚于开始时间'); return; }
    onAddWindow({ id: uid('win'), edgeId: wEdge, start, end });
  };

  const edgeOptions = data.edges;
  const targetEdge = data.edges.find((e) => e.id === cEdge);
  const reconnectCandidates = targetEdge
    ? data.nodes.filter((n) => ![targetEdge.source, targetEdge.target].includes(n.id))
    : [];

  const submit = () => {
    onSubmit({
      edgeId: cEdge,
      kind: cKind,
      priority: Number(cPriority),
      payload: cKind === 'reconnect' ? { which, nodeId: newNode } : null,
    });
    setNewNode('');
  };

  const kindText = (c) => {
    if (c.kind === 'disconnect') return '断开（拆除）链路';
    const e = data.edges.find((x) => x.id === c.edgeId);
    const dest = data.nodes.find((n) => n.id === c.payload?.nodeId)?.name ?? c.payload?.nodeId;
    return `改接链路：${c.payload?.which === 'source' ? 'A' : 'B'}端 → ${dest}${e ? '' : '（链路已不存在）'}`;
  };

  const sortedChanges = [...changes].sort((a, b) => b.seq - a.seq);

  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div><strong>变更管理 · 检修窗口</strong><small>窗口外挂起，到点自动生效</small></div>
          <button className="drawer-close" onClick={onClose}>×</button>
        </div>

        <div className="drawer-body">
          {/* 检修窗口登记 */}
          <section className="card">
            <h3>检修窗口</h3>
            <label>链路
              <select value={wEdge} onChange={(e) => { setWEdge(e.target.value); onPickEdge(e.target.value); }}>
                {edgeOptions.map((e) => <option key={e.id} value={e.id}>{edgeName(e)}</option>)}
              </select>
            </label>
            <div className="row2">
              <label>开始
                <input type="datetime-local" value={wStart} onChange={(e) => setWStart(e.target.value)} />
              </label>
              <label>结束
                <input type="datetime-local" value={wEnd} onChange={(e) => setWEnd(e.target.value)} />
              </label>
            </div>
            <div className="presets">
              <button onClick={() => preset(0, 10)}>即刻起 10 分钟</button>
              <button onClick={() => preset(60, 20)}>1 小时后</button>
              <button onClick={() => preset(24 * 60, 30)}>明天此时</button>
            </div>
            <button className="primary" onClick={addWindow}>登记窗口</button>

            <ul className="window-list">
              {windows.length === 0 && <li className="empty">暂无窗口，变更提交后将先挂起</li>}
              {windows.map((w) => {
                const st = windowStatus(w, now);
                return (
                  <li key={w.id} className={st === 'active' ? 'win-active' : ''}>
                    <div>
                      <strong>{edgeName(data.edges.find((e) => e.id === w.edgeId))}</strong>
                      <small>{fmtTime(w.start)} ~ {fmtTime(w.end)}</small>
                    </div>
                    <span className={'tag tag-' + st}>
                      {st === 'active' ? '进行中' : st === 'scheduled' ? '未开始' : '已结束'}
                    </span>
                    <button className="x" onClick={() => onRemoveWindow(w.id)}>×</button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* 提交变更 */}
          <section className="card">
            <h3>提交变更</h3>
            <label>目标链路
              <select value={cEdge} onChange={(e) => { setCEdge(e.target.value); onPickEdge(e.target.value); setNewNode(''); }}>
                {edgeOptions.map((e) => <option key={e.id} value={e.id}>{edgeName(e)}</option>)}
              </select>
            </label>
            <label>变更类型
              <select value={cKind} onChange={(e) => setCKind(e.target.value)}>
                <option value="disconnect">断开（拆除）链路</option>
                <option value="reconnect">改接链路（更换一端设备）</option>
              </select>
            </label>
            {cKind === 'reconnect' && (
              <div className="row2">
                <label>更换端
                  <select value={which} onChange={(e) => setWhich(e.target.value)}>
                    <option value="source">A 端（{data.nodes.find((n) => n.id === targetEdge?.source)?.name}）</option>
                    <option value="target">B 端（{data.nodes.find((n) => n.id === targetEdge?.target)?.name}）</option>
                  </select>
                </label>
                <label>新接到
                  <select value={newNode} onChange={(e) => setNewNode(e.target.value)}>
                    <option value="">选择设备…</option>
                    {reconnectCandidates.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                  </select>
                </label>
              </div>
            )}
            <label>优先级（同链路并发时，低者被拒绝）
              <select value={cPriority} onChange={(e) => setCPriority(e.target.value)}>
                <option value="3">高</option>
                <option value="2">中</option>
                <option value="1">低</option>
              </select>
            </label>
            <button className="primary" onClick={submit}>提交变更</button>
            <button className="ghost" onClick={() => onRunDue()}>⏱ 立即检查并生效到期变更</button>
          </section>

          {/* 变更队列 */}
          <section className="card">
            <h3>变更队列 <small className="queue-sum">
              挂起 {changes.filter((c) => c.status === 'held').length} ·
              已生效 {changes.filter((c) => c.status === 'applied').length} ·
              拒绝 {changes.filter((c) => c.status === 'rejected').length}
            </small></h3>
            <ul className="change-list">
              {sortedChanges.length === 0 && <li className="empty">还没有变更单</li>}
              {sortedChanges.map((c) => (
                <li key={c.id} className={'change st-' + c.status}>
                  <div className="change-top">
                    <strong>{c.label}</strong>
                    <span className={'prio p' + c.priority}>优先级 {PRIORITY[c.priority]}</span>
                    <span className={'tag tag-' + c.status}>
                      {c.status === 'held' ? '挂起中'
                        : c.status === 'applied' ? '已生效'
                        : c.status === 'rejected' ? '已拒绝' : '已回退'}
                    </span>
                  </div>
                  <div className="change-link">{edgeName(data.edges.find((e) => e.id === c.edgeId))}</div>
                  <div className="change-kind">{kindText(c)}</div>
                  <div className="change-meta">
                    提交 {fmtTime(c.createdAt)}
                    {c.appliedAt && <> · 生效 {fmtTime(c.appliedAt)} · 快照✓</>}
                  </div>
                  {c.status === 'held' && (
                    <div className="change-meta">
                      {windows.some((w) => w.edgeId === c.edgeId && windowStatus(w, now) !== 'ended')
                        ? '等待该链路检修窗口开始后自动生效'
                        : '⚠ 该链路尚无有效检修窗口，将一直挂起'}
                    </div>
                  )}
                  {c.status === 'rejected' && <div className="reject-reason">{c.rejectReason}</div>}
                  {c.status === 'applied' && (
                    <button className="rollback" onClick={() => onRollback(c)}>
                      ↩ 一键回退（仅恢复该链路及两端设备）
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
