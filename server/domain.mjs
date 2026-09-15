import {z} from 'zod';
export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const text=(max=200)=>z.string().trim().max(max).default('');
export const personSchema=z.object({name:z.string().trim().min(1).max(80),alias:text(),gender:z.enum(['male','female','unknown']).default('unknown'),branch:text(80),generation:text(30),birth:text(80),birthLunar:text(80),death:text(80),calendar:z.enum(['solar','lunar','unknown']).default('unknown'),status:z.enum(['living','deceased','unknown']).default('living'),origin:text(),residence:text(),phone:text(60),biography:text(10000),source:text(3000),certainty:z.enum(['verified','pending','disputed']).default('pending')}).transform(person=>{
 const legacyLunar=person.calendar==='lunar'&&!person.birthLunar;
 return {...person,birth:legacyLunar?'':person.birth,birthLunar:legacyLunar?person.birth:person.birthLunar,death:person.status==='deceased'?person.death:''};
});
export const familySchema=z.object({name:z.string().trim().min(1).max(100),description:text(5000),origin:text(),generationPoem:text(1000)});
export const accountSchema=z.object({username:z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9_.@-]+$/),name:z.string().trim().min(1).max(80),password:z.string().min(6,'密码至少 6 位').max(128)});
export function normalizePhone(value){
 const compact=String(value||'').trim().replace(/[\s\-()]/g,'');
 if(/^\+86\d{11}$/.test(compact))return compact.slice(3);
 if(/^0086\d{11}$/.test(compact))return compact.slice(4);
 return compact;
}
export const registrationSchema=z.object({
 name:z.string().trim().min(1,'请填写姓名').max(60),
 phone:z.string().transform(normalizePhone).pipe(z.string().regex(/^\+?\d{6,20}$/,'请填写有效的手机号码')),
});
export const relationSchema=z.object({source:z.uuid(),target:z.uuid(),type:z.enum(['parent','partner']),data:z.object({start:text(80),end:text(80),note:text(2000),certainty:z.enum(['verified','pending','disputed']).default('pending')}).default({})});
export function canEdit(u){return u?.role==='admin'||u?.role==='editor';}
export function canRead(u){return Boolean(u);}
export function sanitizePerson(_u,row){return {id:row.id,...row.data,version:row.version,updatedAt:row.updated_at};}
export function checkGraph(relations){
 const next=new Map();for(const r of relations){if(r.source===r.target)fail(422,'不能把同一人物连接到自己');if(r.type==='partner')continue;const a=next.get(r.source)||[];a.push(r.target);next.set(r.source,a);}
 const done=new Set(),active=new Set();function visit(id){if(active.has(id))fail(422,'该关系会形成祖先循环，请核对父母和子女方向');if(done.has(id))return;active.add(id);for(const t of next.get(id)||[])visit(t);active.delete(id);done.add(id);}
 for(const id of next.keys())visit(id);
}
export function warnings(p,all){const out=[];if(all.some(x=>x.name===p.name))out.push('存在同名人物，请核对后再保存；系统不会自动合并。');const b=/^\d{4}$/.test(p.birth)?Number(p.birth):null,d=/^\d{4}$/.test(p.death)?Number(p.death):null;if(b&&d&&d<b)out.push('去世年份早于出生年份，请核对。');return out;}
