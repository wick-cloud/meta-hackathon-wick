import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { Actor, Role } from '../shared/types.js';
import { HttpError } from './context.js';
export function createAuth(config:Config,pool:Pool){
 return betterAuth({
  database:pool,secret:config.authSecret,baseURL:config.appUrl,basePath:'/api/auth',
  trustedOrigins:[config.appUrl],
  emailAndPassword:{enabled:true,disableSignUp:true,minPasswordLength:12,requireEmailVerification:false},
  user:{additionalFields:{role:{type:'string',required:true,defaultValue:'buyer',input:false},providerId:{type:'string',required:false,input:false}}},
  session:{expiresIn:60*60*12,updateAge:60*60,cookieCache:{enabled:false}},
  rateLimit:{enabled:true,window:60,max:60,customRules:{'/sign-in/email':{window:60,max:10}}},
  advanced:{useSecureCookies:config.nodeEnv==='production',defaultCookieAttributes:{sameSite:'lax',httpOnly:true}},
 });
}
export function createRequireActor(auth:ReturnType<typeof createAuth>,pool:Pool){
 return async(request:FastifyRequest,roles?:Role[]):Promise<Actor>=>{
  const session=await auth.api.getSession({headers:fromNodeHeaders(request.headers)});
  if(!session)throw new HttpError(401,'Please sign in to continue.');
  const {rows}=await pool.query('SELECT id,email,name,role,"providerId" FROM "user" WHERE id=$1',[session.user.id]);
  const actor=rows[0] as Actor|undefined;
  if(!actor)throw new HttpError(401,'This account is no longer active.');
  if(roles&&!roles.includes(actor.role))throw new HttpError(403,'This action is not available for your role.');
  return actor;
 };
}
export async function registerAuth(app:FastifyInstance,auth:ReturnType<typeof createAuth>,config:Config){
 app.route({method:['GET','POST'],url:'/api/auth/*',async handler(request,reply){
  const url=new URL(request.raw.url!,config.appUrl);
  const headers=fromNodeHeaders(request.headers);
  const response=await auth.handler(new Request(url,{method:request.method,headers,...(request.method!=='GET'&&request.method!=='HEAD'?{body:JSON.stringify(request.body??{})}:{})}));
  reply.code(response.status);
  response.headers.forEach((value,key)=>{if(key!=='set-cookie')reply.header(key,value);});
  const cookies=response.headers.getSetCookie();if(cookies.length)reply.header('set-cookie',cookies);
  return reply.send(await response.text());
 }});
}
