import assert from 'node:assert/strict';
import {
  processDue, resolveConflict, rollbackInto, makeSnapshot, migrate,
} from '../src/engine.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

/* 测试夹具：a↔b 一条链路，另加 b↔c 作为“无关设备/连线” */
const baseTopo = () => ({
  nodes: [
    { id: 'a', name: 'A', type: 'switch', x: 10, y: 10, ip: '1' },
    { id: 'b', name: 'B', type: 'switch', x: 20, y: 20, ip: '2' },
    { id: 'c', name: 'C', type: 'device', x: 30, y: 30, ip: '3' },
  ],
  edges: [
    { id: 'ab', source: 'a', target: 'b' },
    { id: 'bc', source: 'b', target: 'c' },
  ],
});
const held = (over = {}) => ({
  id: over.id ?? 'chg1', label: over.label ?? '#1', seq: 1,
  edgeId: 'ab', kind: 'disconnect', priority: 2,
  payload: null, createdAt: 100, status: 'held', ...over,
});

/* 1. 窗口外挂起，到窗口才生效 */
test('窗口外：变更保持挂起，不产生快照、不动拓扑', () => {
  const d = baseTopo();
  const r = processDue(d, [held()], [{ id: 'w', edgeId: 'ab', start: 1000, end: 2000 }], 500);
  assert.equal(r.changes[0].status, 'held');
  assert.equal(r.fired.length, 0);
  assert.equal(r.data.edges.length, 2);
  assert.equal(r.changes[0].snapshot, undefined);
});

test('窗口内：先生快照再生效（拆除链路）', () => {
  const d = baseTopo();
  const r = processDue(d, [held()], [{ id: 'w', edgeId: 'ab', start: 1000, end: 2000 }], 1500);
  assert.equal(r.changes[0].status, 'applied');
  assert.equal(r.data.edges.find((e) => e.id === 'ab'), undefined);
  assert.equal(r.data.edges.length, 1);
  // 快照只含 ab 链路和 a、b 两端，不含无关的 c / bc
  assert.deepEqual(r.changes[0].snapshot.edge, { id: 'ab', source: 'a', target: 'b' });
  assert.deepEqual(r.changes[0].snapshot.endpoints.map((n) => n.id).sort(), ['a', 'b']);
  assert.equal(r.changes[0].appliedAt, 1500);
});

/* 2. 冲突仲裁：低优先级被拒绝，不覆盖 */
test('同链路同优先级：后来者被拒绝，先到者保持挂起', () => {
  const first = held({ id: 'c1', label: '#1' });
  const second = held({ id: 'c2', label: '#2', createdAt: 200 });
  const r = resolveConflict([first], second);
  assert.equal(r.accepted, false);
  assert.equal(r.changes.find((c) => c.id === 'c1').status, 'held');
  assert.equal(r.changes.find((c) => c.id === 'c2').status, 'rejected');
  assert.match(r.changes.find((c) => c.id === 'c2').rejectReason, /冲突/);
});

test('同链路后来者优先级更低：被拒绝并提示冲突原因', () => {
  const first = held({ id: 'c1', label: '#1', priority: 3 });
  const second = held({ id: 'c2', label: '#2', priority: 1, createdAt: 200 });
  const r = resolveConflict([first], second);
  assert.equal(r.accepted, false);
  assert.equal(r.changes.find((c) => c.id === 'c1').status, 'held');
  assert.equal(r.changes.find((c) => c.id === 'c2').status, 'rejected');
});

test('同链路后来者优先级更高：先到的低优先级一方被拒绝，绝不静默', () => {
  const first = held({ id: 'c1', label: '#1', priority: 1 });
  const second = held({ id: 'c2', label: '#2', priority: 3, createdAt: 200 });
  const r = resolveConflict([first], second);
  assert.equal(r.accepted, true);
  assert.equal(r.changes.find((c) => c.id === 'c1').status, 'rejected');
  assert.match(r.changes.find((c) => c.id === 'c1').rejectReason, /#2/);
  assert.equal(r.changes.find((c) => c.id === 'c2').status, 'held');
});

test('不同链路的并发变更互不冲突', () => {
  const first = held({ id: 'c1', edgeId: 'ab' });
  const second = held({ id: 'c2', edgeId: 'bc' });
  const r = resolveConflict([first], second);
  assert.equal(r.accepted, true);
  assert.equal(r.changes.filter((c) => c.status === 'held').length, 2);
});

/* 3. 快照回退：只恢复该链路和两端，其他设备照旧 */
test('断开生效后回退：链路插回，端点位置还原，无关设备的新位置不动', () => {
  const d = baseTopo();
  const snap = makeSnapshot(d, d.edges[0]);
  // 生效：ab 被拆除；随后有人把 a 挪走、把无关设备 c 挪到新位置
  const live = {
    nodes: d.nodes.map((n) =>
      n.id === 'a' ? { ...n, x: 999 } : n.id === 'c' ? { ...n, x: 777 } : n),
    edges: d.edges.filter((e) => e.id !== 'ab'),
  };
  const back = rollbackInto(live, snap);
  assert.deepEqual(back.edges.map((e) => e.id).sort(), ['ab', 'bc']); // 链路恢复
  assert.equal(back.nodes.find((n) => n.id === 'a').x, 10);            // 端点还原
  assert.equal(back.nodes.find((n) => n.id === 'c').x, 777);           // 无关设备照旧
});

test('改接生效后回退：该端指回旧设备，其他连线不受影响', () => {
  const d = baseTopo();
  const snap = makeSnapshot(d, d.edges[0]);
  const change = held({ kind: 'reconnect', payload: { which: 'target', nodeId: 'c' } });
  const applied = processDue(d, [change], [{ id: 'w', edgeId: 'ab', start: 0, end: 9999 }], 10);
  assert.equal(applied.data.edges.find((e) => e.id === 'ab').target, 'c');
  const back = rollbackInto(applied.data, snap);
  assert.deepEqual(back.edges.find((e) => e.id === 'ab'), { id: 'ab', source: 'a', target: 'b' });
  assert.deepEqual(back.edges.find((e) => e.id === 'bc'), { id: 'bc', source: 'b', target: 'c' });
});

/* 4. 边界：目标链路已不存在时到期 → 拒绝 */
test('链路已被删除时变更到期：拒绝并给出原因', () => {
  const d = { nodes: baseTopo().nodes, edges: [{ id: 'bc', source: 'b', target: 'c' }] };
  const r = processDue(d, [held()], [{ id: 'w', edgeId: 'ab', start: 0, end: 9999 }], 10);
  assert.equal(r.changes[0].status, 'rejected');
  assert.match(r.changes[0].rejectReason, /不存在/);
});

/* 5. 旧格式迁移 */
test('旧版数组边格式迁移为带稳定 id 的对象', () => {
  const m = migrate({ nodes: [], edges: [['sw2', 'gw']] });
  assert.deepEqual(m.edges[0], { id: 'e-gw-sw2', source: 'sw2', target: 'gw' });
});

console.log(`\n全部 ${passed} 项引擎规则测试通过`);
