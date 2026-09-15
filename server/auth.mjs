import {randomBytes,scrypt as scryptCb,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCb);
export const token=()=>randomBytes(32).toString('hex');
export const digest=v=>createHash('sha256').update(v).digest('hex');
export async function hashPassword(password){const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `${salt}:${key.toString('hex')}`;}
export async function verifyPassword(password,stored){const [salt,hex]=stored.split(':');const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});const expected=Buffer.from(hex,'hex');return expected.length===key.length&&timingSafeEqual(expected,key);}
export function equalSecret(a,b){const x=digest(String(a||'')),y=digest(String(b||''));return timingSafeEqual(Buffer.from(x),Buffer.from(y));}
