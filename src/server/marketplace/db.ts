import type { Pool, PoolClient } from 'pg';
import type { AppContext } from '../context.js';
import type { Receipt,Mode } from '../../shared/types.js';
export async function transaction<T>(pool:Pool,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await pool.connect();
  try { await db.query('BEGIN'); const value=await fn(db); await db.query('COMMIT'); return value; }
  catch(error){await db.query('ROLLBACK');throw error;} finally{db.release();}
}
export const QUEUES={close:'broker-auction-close',auto:'broker-auto-bid',provision:'broker-provision',cleanup:'broker-cleanup'} as const;
export async function enqueue(ctx:AppContext,db:PoolClient,name:string,data:object,delaySeconds=0){
  return ctx.boss.send(name,data,{startAfter:delaySeconds, retryLimit:3,retryDelay:5,expireInSeconds:120, db:{executeSql:async(text:string,values?:unknown[])=>db.query(text,values)}});
}
export async function activity(db:PoolClient,providerId:string|null,requestId:string|null,kind:string,message:string,details?:{receipt?:Receipt;mode?:Mode;modelCalled?:boolean}){
  await db.query('INSERT INTO broker_activity(provider_id,request_id,kind,message,receipt,mode,model_called) VALUES($1,$2,$3,$4,$5,$6,$7)',[providerId,requestId,kind,message,details?.receipt??null,details?.mode??null,details?.modelCalled??null]);
}
