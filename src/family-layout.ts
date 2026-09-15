import { displayedBirth, type GraphData, type Person, type Relation } from './types.ts';

export const CARD_WIDTH = 116;
export const CARD_HEIGHT = 164;
export const COUPLE_GAP = 20;
export const ROW_GAP = 250;
const FAMILY_GAP = 18;
const MARGIN = 36;
const LABEL_GUTTER = 92;

export type FamilyUnit = { id: string; parents: string[]; children: string[]; partner: boolean };
export type LayoutNode = Person & { key: string; x: number; y: number; level: number; reference: boolean };
export type FamilyConnection = { key: string; id: string; parentKeys: string[]; childKeys: string[]; parents: string[]; children: string[]; partner: boolean; x: number; y: number; left: number; right: number; childCount: number; collapsed: boolean };
type Branch = { width: number; anchor: number; anchorKey: string; blocks: Block[]; leaf?: LayoutNode };
type Block = { unit: FamilyUnit; width: number; center: number; left: number; parentNodes: LayoutNode[]; children: { branch: Branch; left: number }[]; collapsed: boolean };

const sexRank = (gender: string) => gender === 'male' ? 0 : gender === 'female' ? 2 : 1;
function birthOrder(value: string) {
  const match = /^(\d{4})(?:[.\-/年](\d{1,2}))?(?:[.\-/月](\d{1,2}))?/.exec(value || '');
  return match ? Number(match[1]) * 10000 + Number(match[2] || 1) * 100 + Number(match[3] || 1) : Infinity;
}
export function comparePeople(a: Person, b: Person) {
  return sexRank(a.gender) - sexRank(b.gender) || (birthOrder(displayedBirth(a)) - birthOrder(displayedBirth(b)) || 0) || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id);
}
const familyId = (ids: string[]) => 'family:' + [...ids].sort().join('|');

export function familyUnits(data: GraphData): FamilyUnit[] {
  const people = new Map(data.people.map(p => [p.id, p]));
  const parents = new Map<string, Set<string>>();
  for (const edge of data.relations) {
    if (edge.type === 'partner' || !people.has(edge.source) || !people.has(edge.target)) continue;
    const set = parents.get(edge.target) || new Set<string>();
    set.add(edge.source); parents.set(edge.target, set);
  }
  const families = new Map<string, FamilyUnit>();
  for (const [child, ids] of parents) {
    const values = [...ids].sort((a, b) => comparePeople(people.get(a)!, people.get(b)!));
    const key = familyId(values);
    const unit = families.get(key) || { id: key, parents: values, children: [], partner: false };
    unit.children.push(child); families.set(key, unit);
  }
  for (const edge of data.relations) {
    if (edge.type !== 'partner' || !people.has(edge.source) || !people.has(edge.target)) continue;
    const ids = [edge.source, edge.target].sort((a, b) => comparePeople(people.get(a)!, people.get(b)!));
    const key = familyId(ids);
    const unit = families.get(key) || { id: key, parents: ids, children: [], partner: false };
    unit.partner = true; families.set(key, unit);
  }
  for (const unit of families.values()) unit.children.sort((a, b) => comparePeople(people.get(a)!, people.get(b)!));
  return [...families.values()].sort((a, b) => Number(!a.children.length) - Number(!b.children.length) || a.id.localeCompare(b.id));
}

export function relatives(data: GraphData, id: string) {
  const ids = new Set([id]);
  const units = familyUnits(data);
  for (const unit of units) if (unit.parents.includes(id) || unit.children.includes(id)) {
    unit.parents.forEach(value => ids.add(value));
    unit.children.forEach(value => ids.add(value));
  }
  return ids;
}

export function generationLevels(data: GraphData) {
  const people = new Set(data.people.map(person => person.id));
  const parent = new Map([...people].map(id => [id, id]));
  const find = (id: string): string => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const left = find(a), right = find(b);
    if (left !== right) parent.set(right, left);
  };
  const parentsByChild = new Map<string, string[]>();
  for (const relation of data.relations) {
    if (!people.has(relation.source) || !people.has(relation.target)) continue;
    if (relation.type === 'partner') union(relation.source, relation.target);
    else parentsByChild.set(relation.target, [...(parentsByChild.get(relation.target) || []), relation.source]);
  }
  for (const values of parentsByChild.values()) {
    for (const value of values.slice(1)) union(values[0], value);
  }
  const groups = new Set([...people].map(find));
  const next = new Map<string, Set<string>>(), incoming = new Map([...groups].map(id => [id, 0]));
  for (const relation of data.relations) {
    if (relation.type === 'partner' || !people.has(relation.source) || !people.has(relation.target)) continue;
    const source = find(relation.source), target = find(relation.target);
    if (source === target) continue;
    const children = next.get(source) || new Set<string>();
    if (!children.has(target)) {
      children.add(target);
      next.set(source, children);
      incoming.set(target, (incoming.get(target) || 0) + 1);
    }
  }
  const levels = new Map([...groups].map(id => [id, 0]));
  const queue = [...groups].filter(id => !incoming.get(id)).sort();
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index];
    for (const target of next.get(source) || []) {
      levels.set(target, Math.max(levels.get(target) || 0, (levels.get(source) || 0) + 1));
      incoming.set(target, (incoming.get(target) || 0) - 1);
      if (!incoming.get(target)) queue.push(target);
    }
  }
  return new Map([...people].map(id => [id, levels.get(find(id)) || 0]));
}

export function pathBetween(data: GraphData, from: string, to: string) {
  const queue = [[from]], seen = new Set([from]);
  for (const route of queue) {
    const id = route.at(-1)!;
    if (id === to) return route;
    for (const edge of data.relations) {
      const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
      if (other && !seen.has(other)) { seen.add(other); queue.push([...route, other]); }
    }
  }
  return [];
}

export function createFamilyLayout(data: GraphData, options: { root?: string; depth?: number; mode?: string; startGeneration?: number; collapsed?: Set<string> } = {}) {
  const root = options.root || '';
  const depth = options.depth === 0 ? Math.max(1, data.people.length + 1) : Math.max(1, Math.min(100, options.depth ?? 3));
  const startGeneration = Math.max(1, options.startGeneration || 1), startLevel = startGeneration - 1;
  const actualLevels = generationLevels(data);
  const collapsed = options.collapsed || new Set<string>();
  const sorted = [...data.people].sort(comparePeople);
  const allowed = options.mode === 'kin' ? relatives(data, root || sorted[0]?.id || '') : null;
  const visible: GraphData = { people: sorted.filter(p => !allowed || allowed.has(p.id)), relations: data.relations };
  const people = new Map(visible.people.map(p => [p.id, p]));
  const units = familyUnits(visible);
  const byParent = new Map<string, FamilyUnit[]>();
  const parented = new Set<string>();
  units.forEach(unit => {
    unit.parents.forEach(id => byParent.set(id, [...(byParent.get(id) || []), unit]));
    unit.children.forEach(id => parented.add(id));
  });
  const expanded = new Set<string>(), seenPeople = new Set<string>();
  const nodes: LayoutNode[] = [], families: FamilyConnection[] = [];
  let serial = 0, occurrenceCount = 0, truncated = false;
  function node(id: string, level: number): LayoutNode {
    const reference = seenPeople.has(id);
    seenPeople.add(id); occurrenceCount++;
    return { ...people.get(id)!, key: `${id}:${serial++}`, x: 0, y: MARGIN + level * ROW_GAP, level, reference };
  }
  function build(id: string, level: number): Branch {
    const budgetHit = occurrenceCount >= 300 || seenPeople.size >= 160;
    if (budgetHit) truncated = true;
    const available = budgetHit ? [] : (byParent.get(id) || []).filter(unit => !expanded.has(unit.id));
    if (!available.length) {
      const leaf = node(id, level);
      return { width: CARD_WIDTH, anchor: CARD_WIDTH / 2, anchorKey: leaf.key, blocks: [], leaf };
    }
    const blocks: Block[] = [];
    let width = 0, anchor = 0, anchorKey = '';
    for (const unit of available) {
      if (expanded.has(unit.id)) continue;
      expanded.add(unit.id);
      const parentNodes = unit.parents.map(value => node(value, level));
      const isCollapsed = collapsed.has(unit.id);
      const branches: Branch[] = [];
      if (level + 1 < depth && !isCollapsed) for (const child of unit.children) {
        if (occurrenceCount >= 300 || seenPeople.size >= 160) { truncated = true; break; }
        branches.push(build(child, level + 1));
      }
      let childWidth = 0;
      const children = branches.map(branch => {
        const item = { branch, left: childWidth };
        childWidth += branch.width + FAMILY_GAP;
        return item;
      });
      if (children.length) childWidth -= FAMILY_GAP;
      const childCenter = children.length ? (children[0].branch.anchor + children.at(-1)!.left + children.at(-1)!.branch.anchor) / 2 : 0;
      const parentWidth = parentNodes.length * CARD_WIDTH + (parentNodes.length - 1) * COUPLE_GAP;
      const min = Math.min(-parentWidth / 2, children.length ? -childCenter : 0);
      const max = Math.max(parentWidth / 2, children.length ? childWidth - childCenter : 0);
      const center = -min, blockWidth = max - min;
      parentNodes.forEach((p, i) => { p.x = center - parentWidth / 2 + i * (CARD_WIDTH + COUPLE_GAP); });
      children.forEach(child => { child.left += center - childCenter; });
      if (!blocks.length) {
        const focal = parentNodes.find(p => p.id === id)!;
        anchor = focal.x + CARD_WIDTH / 2; anchorKey = focal.key;
      }
      blocks.push({ unit, parentNodes, children, center, width: blockWidth, left: width, collapsed: isCollapsed });
      width += blockWidth + FAMILY_GAP;
    }
    return { width: width - FAMILY_GAP, anchor, anchorKey, blocks };
  }
  function place(branch: Branch, x: number) {
    if (branch.leaf) { branch.leaf.x += x; nodes.push(branch.leaf); return; }
    for (const block of branch.blocks) {
      const bx = x + block.left;
      block.parentNodes.forEach(p => { p.x += bx; nodes.push(p); });
      families.push({ key: block.parentNodes[0].key + ':family', id: block.unit.id,
        parentKeys: block.parentNodes.map(p => p.key), childKeys: block.children.map(child => child.branch.anchorKey),
        parents: block.unit.parents, children: block.unit.children, partner: block.unit.partner,
        x: bx + block.center, y: block.parentNodes[0].y, left: bx, right: bx + block.width,
        childCount: block.unit.children.length, collapsed: block.collapsed });
      block.children.forEach(child => place(child.branch, bx + child.left));
    }
  }
  let left = LABEL_GUTTER + MARGIN;
  const generationStarts = options.mode !== 'kin' && options.startGeneration
    ? visible.people.filter(person => actualLevels.get(person.id) === startLevel)
    : null;
  const starts = root && options.mode !== 'kin' && people.has(root)
    ? [people.get(root)!]
    : generationStarts || visible.people.filter(p => !parented.has(p.id) && (byParent.get(p.id) || []).every(unit => unit.parents.every(id => !parented.has(id))));
  if (!(root && options.mode !== 'kin' && people.has(root)) && !generationStarts) {
    // Keep each disconnected component inspectable, even with unusual spouse cycles.
    const visited = new Set<string>();
    const neighbors = new Map<string, Set<string>>();
    for (const relation of visible.relations) {
      if (!people.has(relation.source) || !people.has(relation.target)) continue;
      for (const [a, b] of [[relation.source, relation.target], [relation.target, relation.source]]) {
        const values = neighbors.get(a) || new Set<string>(); values.add(b); neighbors.set(a, values);
      }
    }
    for (const person of visible.people) {
      if (visited.has(person.id)) continue;
      const component = [person.id]; visited.add(person.id);
      for (const id of component) for (const other of neighbors.get(id) || []) {
        if (!visited.has(other)) { visited.add(other); component.push(other); }
      }
      if (!starts.some(start => component.includes(start.id))) {
        starts.push(people.get(component.find(id => !parented.has(id)) || component[0])!);
      }
    }
  }
  for (const person of starts) {
    if (seenPeople.has(person.id) && (byParent.get(person.id) || []).every(unit => expanded.has(unit.id))) continue;
    if (occurrenceCount >= 300 || seenPeople.size >= 160) { truncated = true; break; }
    const branch = build(person.id, 0); place(branch, left); left += branch.width + FAMILY_GAP;
  }
  // A relationship cycle involving spouses must remain inspectable without recursive expansion.
  if (!nodes.length && visible.people.length) {
    const branch = build(visible.people[0].id, 0); place(branch, left); left += branch.width + FAMILY_GAP;
  }
  let canvasWidth = Math.max(720, left - FAMILY_GAP + MARGIN);
  if (options.mode === 'tree' && startGeneration === 1) {
    const earlyGap = 18;
    for (let level = 0; level < 4; level++) {
      const row = nodes.filter(node => node.level === level).sort((a, b) => a.x - b.x || a.key.localeCompare(b.key));
      if (!row.length) continue;
      const rowWidth = row.length * CARD_WIDTH + Math.max(0, row.length - 1) * earlyGap;
      const rowLeft = Math.max(LABEL_GUTTER + MARGIN, (canvasWidth - rowWidth) / 2);
      row.forEach((node, index) => { node.x = rowLeft + index * (CARD_WIDTH + earlyGap); });
      canvasWidth = Math.max(canvasWidth, rowLeft + rowWidth + MARGIN);
    }
    const nodesByKey = new Map(nodes.map(node => [node.key, node]));
    for (const family of families) {
      const parents = family.parentKeys.map(key => nodesByKey.get(key)).filter(Boolean) as LayoutNode[];
      const children = family.childKeys.map(key => nodesByKey.get(key)).filter(Boolean) as LayoutNode[];
      if (parents.length) family.x = (parents[0].x + parents.at(-1)!.x + CARD_WIDTH) / 2;
      const linked = [...parents, ...children];
      if (linked.length) {
        family.left = Math.min(family.left, ...linked.map(node => node.x));
        family.right = Math.max(family.right, ...linked.map(node => node.x + CARD_WIDTH));
      }
    }
  }
  const shownIds = new Set(nodes.map(p => p.id));
  const levels = [...new Set(nodes.map(p => p.level))].sort((a, b) => a - b);
  const rowOffset = options.mode === 'kin' ? 0 : startLevel;
  const rows = levels.map(level => ({ level, y: MARGIN + level * ROW_GAP, label: `第 ${level + rowOffset + 1} 代`, count: new Set(nodes.filter(p => p.level === level).map(p => p.id)).size }));
  const conflicts = options.mode !== 'kin' ? nodes.filter(p => !p.reference && /^\d+$/.test(p.generation || '') && Number(p.generation) !== (actualLevels.get(p.id) || 0) + 1).map(p => p.id) : [];
  return { nodes, families, rows, conflicts, truncated, personCount: shownIds.size, referenceCount: nodes.filter(p => p.reference).length,
    relations: data.relations.filter(r => shownIds.has(r.source) && shownIds.has(r.target)),
    width: canvasWidth, height: Math.max(460, MARGIN * 2 + (levels.at(-1) || 0) * ROW_GAP + CARD_HEIGHT + 44) };
}

export function highlightRelations(relations: Relation[], selected: string, ancestors: boolean) {
  const ids = new Set<string>(), people = new Set<string>();
  if (!selected) return { ids, people };
  people.add(selected);
  const queue = [selected];
  for (const id of queue) for (const relation of relations) {
    const match = ancestors ? relation.type !== 'partner' && relation.target === id : relation.source === selected || relation.target === selected;
    if (!match) continue;
    ids.add(relation.id);
    for (const p of [relation.source, relation.target]) {
      if (!people.has(p)) { people.add(p); if (ancestors) queue.push(p); }
    }
  }
  return { ids, people };
}
