import test from 'node:test';
import assert from 'node:assert/strict';
import {checkGraph,canEdit,canRead,personSchema,relationSchema,sanitizePerson,warnings,normalizePhone,registrationSchema} from '../server/domain.mjs';

test('人物资料默认在世，公历农历分开，只有已故状态保留去世记载',()=>{
  const living=personSchema.parse({name:'林某',birth:'1990.1.1',birthLunar:'庚午年冬月',death:'误填'});
  assert.equal(living.status,'living');
  assert.equal(living.birth,'1990.1.1');
  assert.equal(living.birthLunar,'庚午年冬月');
  assert.equal(living.death,'');
  const deceased=personSchema.parse({name:'林先人',status:'deceased',death:'2020'});
  assert.equal(deceased.death,'2020');
  const legacy=personSchema.parse({name:'林旧录',calendar:'lunar',birth:'甲子年正月'});
  assert.equal(legacy.birth,'');
  assert.equal(legacy.birthLunar,'甲子年正月');
});

test('关系图允许再婚，阻止祖先循环',()=>{
  const valid=[
    {source:'父',target:'子',type:'parent'},
    {source:'父',target:'配偶一',type:'partner'},
    {source:'父',target:'配偶二',type:'partner'},
  ];
  assert.doesNotThrow(()=>checkGraph(valid));
  assert.throws(()=>checkGraph([...valid,{source:'子',target:'父',type:'parent'}]),/祖先循环/);
  assert.throws(()=>checkGraph([{source:'甲',target:'甲',type:'partner'}]),/同一人物/);
  assert.throws(()=>relationSchema.parse({source:'00000000-0000-4000-8000-000000000001',target:'00000000-0000-4000-8000-000000000002',type:'other',data:{}}));
});

test('权限只区分可编辑与仅查看，查看者获得完整资料',()=>{
  const editor={role:'editor',branches:['长房']};
  const living={name:'林某',branch:'长房',status:'living',birth:'1990-01-01',phone:'13800000000',residence:'某地',biography:'个人经历',source:'身份证'};
  assert.equal(canEdit(editor,living),true);
  assert.equal(canEdit(editor,{...living,branch:'二房'}),true);
  assert.equal(canRead({role:'viewer'},living),true);
  assert.equal(canRead({role:'guest',branch:'*'},living),true);
  assert.equal(canRead({role:'guest',branch:'二房'},living),true);
  const clean=sanitizePerson({role:'viewer'},{id:'1',data:living,version:1,updated_at:new Date()});
  assert.equal(clean.phone,'13800000000');
  assert.equal(clean.birth,'1990-01-01');
  assert.equal(clean.biography,'个人经历');
});

test('同名只提示核对，不自动合并',()=>{
  const p={name:'林文远',birth:'1962',death:'',branch:'长房'};
  assert.match(warnings(p,[{name:'林文远'}])[0],/同名人物/);
  assert.match(warnings({...p,death:'1950'},[])[0],/去世年份早于出生年份/);
});

test('受邀成员手机号统一格式',()=>{
  assert.equal(normalizePhone('+86 138-0000-0000'),'13800000000');
  assert.deepEqual(registrationSchema.parse({name:' 林某 ',phone:'0086 139 0000 0000'}),{name:'林某',phone:'13900000000'});
  assert.throws(()=>registrationSchema.parse({name:'林某',phone:'abc'}));
});
