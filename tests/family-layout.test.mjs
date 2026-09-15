import test from 'node:test';
import assert from 'node:assert/strict';
import { createFamilyLayout, familyUnits, generationLevels, CARD_WIDTH, CARD_HEIGHT, highlightRelations } from '../src/family-layout.ts';

const person = (id, gender = 'male', birth = '', generation = '') => ({ id, name: id, gender, birth, generation, death: '', branch: '', alias: '', calendar: 'unknown', status: 'unknown', origin: '', residence: '', phone: '', biography: '', source: '', certainty: 'pending', version: 1 });
const edge = (source, target, type = 'parent') => ({ id: `${source}-${target}-${type}`, source, target, type, data: {}, version: 1 });
const parents = (a, b, children) => children.flatMap(child => [edge(a, child), edge(b, child)]);
function fixture() {
  return { people: [person('grandfather','male','1936'), person('grandmother','female','1939'), person('sonA','male','1960'), person('sonB','male','1965'), person('sonC','male','1968'), person('wifeC','female','1967'), person('grandsonA','male','1987'), person('grandsonC','male','1989'), person('wifeGC','female','1995'), person('daughter','female','2023','2')],
    relations: [...parents('grandfather','grandmother',['sonA','sonB','sonC']), ...parents('sonC','wifeC',['grandsonC']), edge('sonA','grandsonA'), edge('grandsonC','wifeGC','partner'), ...parents('grandsonC','wifeGC',['daughter'])] };
}
const center = node => node.x + CARD_WIDTH / 2;
function noOverlap(layout) {
  for (const [i,a] of layout.nodes.entries()) for (const b of layout.nodes.slice(i+1)) {
    assert(!(a.x < b.x + CARD_WIDTH && b.x < a.x + CARD_WIDTH && a.y < b.y + CARD_HEIGHT && b.y < a.y + CARD_HEIGHT), `${a.id}/${b.id} overlap`);
  }
  for (const f of layout.families) for (const key of f.childKeys) {
    const child=layout.nodes.find(n=>n.key===key);
    assert(child.y > f.y + CARD_HEIGHT);
    assert(child.x >= f.left && child.x+CARD_WIDTH <= f.right);
  }
}

test('复现四代图：共同父母相邻、独生子居中、代数不被手填字段覆盖', () => {
  const data=fixture(), layout=createFamilyLayout(data,{depth:8});
  noOverlap(layout);
  assert.deepEqual(layout.rows.map(r=>r.label),['第 1 代','第 2 代','第 3 代','第 4 代']);
  assert.deepEqual(layout.conflicts,['daughter']);
  const root=layout.families.find(f=>f.parents.includes('grandfather'));
  assert.equal(root.partner,false);
  assert.equal(root.childKeys.length,3);
  for (const f of layout.families.filter(f=>f.childKeys.length===1)) assert.equal(center(layout.nodes.find(n=>n.key===f.childKeys[0])), f.x);
  assert.equal(layout.personCount,data.people.length);
  const c=layout.nodes.find(n=>n.id==='sonC'), a=layout.nodes.find(n=>n.id==='sonA');
  assert(c.x>a.x);
  assert(layout.nodes.find(n=>n.id==='grandsonC').x>layout.nodes.find(n=>n.id==='grandsonA').x);
});

test('全部家人可按自动计算的代数开始，并支持展示全部后代', () => {
  const data = fixture(), levels = generationLevels(data);
  assert.equal(levels.get('grandfather'), 0);
  assert.equal(levels.get('grandmother'), 0);
  assert.equal(levels.get('sonC'), 1);
  assert.equal(levels.get('wifeC'), 1);
  assert.equal(levels.get('grandsonC'), 2);
  assert.equal(levels.get('daughter'), 3);

  const second = createFamilyLayout(data, { depth: 0, startGeneration: 2 });
  assert(!second.nodes.some(node => node.id === 'grandfather' || node.id === 'grandmother'));
  assert(second.nodes.some(node => node.id === 'sonA'));
  assert(second.nodes.some(node => node.id === 'wifeC'));
  assert(second.nodes.some(node => node.id === 'daughter'));
  assert.deepEqual(second.rows.map(row => row.label), ['第 2 代', '第 3 代', '第 4 代']);
  noOverlap(second);
});

test('全部家人的前四代紧凑排列，同时保持关系连接范围有效', () => {
  const layout = createFamilyLayout(fixture(), { mode: 'tree', depth: 0, startGeneration: 1 });
  for (const level of [0, 1, 2, 3]) {
    const row = layout.nodes.filter(node => node.level === level).sort((a, b) => a.x - b.x);
    for (let index = 1; index < row.length; index++) {
      assert(row[index].x - (row[index - 1].x + CARD_WIDTH) <= 18);
    }
  }
  noOverlap(layout);
});

test('男女排序与出生顺序稳定，输入顺序不会改动布局', () => {
  const data={people:[person('dad'),person('mom','female'),person('daughter','female','1980'),person('young','male','1990'),person('older','male','1985')],relations:parents('dad','mom',['daughter','young','older'])};
  const layout=createFamilyLayout(data);
  const f=layout.families[0];
  assert.deepEqual(f.children,['older','young','daughter']);
  const flipped=createFamilyLayout({people:[...data.people].reverse(),relations:[...data.relations].reverse()});
  assert.deepEqual(flipped.nodes.map(p=>[p.id,p.x,p.y]),layout.nodes.map(p=>[p.id,p.x,p.y]));
  noOverlap(layout);
});

test('多个家庭保留各自的子女，并明确使用同一人物引用', () => {
  const data={people:[person('father'),person('wife1','female'),person('wife2','female'),person('child1'),person('child2','female')],relations:[edge('father','wife1','partner'),edge('father','wife2','partner'),...parents('father','wife1',['child1']),...parents('father','wife2',['child2'])]};
  const layout=createFamilyLayout(data);
  assert.equal(layout.families.length,2);
  assert.equal(layout.personCount,5);
  assert.equal(layout.nodes.filter(p=>p.id==='father').length,2);
  assert.equal(layout.referenceCount,1);
  assert(!layout.families.some(f=>f.children.includes('child1')&&f.children.includes('child2')));
  noOverlap(layout);
});

test('家庭折叠隐藏本家后代；从指定人物展开及查看家庭保留真实关系', () => {
  const data=fixture(), family=familyUnits(data).find(f=>f.parents.includes('sonC'));
  const layout=createFamilyLayout(data,{depth:8,collapsed:new Set([family.id])});
  assert(!layout.nodes.some(p=>p.id==='grandsonC'||p.id==='daughter'));
  assert(layout.nodes.some(p=>p.id==='grandsonA'));
  const focused=createFamilyLayout(data,{root:'sonC',depth:8});
  assert(!focused.nodes.some(p=>p.id==='grandfather'));
  assert(focused.nodes.some(p=>p.id==='wifeC'));
  const kin=createFamilyLayout(data,{root:'grandsonC',depth:8,mode:'kin'});
  assert(kin.nodes.some(p=>p.id==='sonC')&&kin.nodes.some(p=>p.id==='daughter'));
  assert(!kin.nodes.some(p=>p.id==='grandfather'));
});

test('共享后代仍只是一份档案，布局不因引用产生重叠或无限递归', () => {
  const data={people:[person('a'),person('b','female'),person('c'),person('d','female'),person('son'),person('wife','female'),person('child')],relations:[...parents('a','b',['son']),...parents('c','d',['wife']),...parents('son','wife',['child']),edge('son','wife','partner')]};
  const layout=createFamilyLayout(data,{depth:8});
  assert.equal(layout.personCount,7);
  assert(layout.referenceCount>0);
  assert.equal(layout.families.filter(f=>f.children.includes('child')).length,1);
  noOverlap(layout);
});

test('默认高亮直接家人；主动查看祖辈时才递归', () => {
  const data=fixture();
  const direct=highlightRelations(data.relations,'grandsonC',false);
  assert(!direct.people.has('grandfather'));
  assert(direct.people.has('wifeGC')&&direct.people.has('daughter')&&direct.people.has('sonC'));
  const ancestors=highlightRelations(data.relations,'grandsonC',true);
  assert(ancestors.people.has('grandfather'));
  assert(!ancestors.people.has('daughter')&&!ancestors.people.has('wifeGC'));
});

test('独立人物和复杂配偶环并存时，各家庭都能查看且不会无限展开', () => {
  const data = {
    people: [person('isolated'), person('p'), person('q'), person('r','female'), person('s','female')],
    relations: [edge('p','q'), edge('r','s'), edge('p','s','partner'), edge('r','q','partner')],
  };
  const layout = createFamilyLayout(data, {depth:8});
  assert.equal(layout.personCount, 5);
  assert(layout.nodes.length < 20);
  noOverlap(layout);
});
