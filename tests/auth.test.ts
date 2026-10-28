import 'dotenv/config';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {hashPassword} from 'better-auth/crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {loadConfig} from '../src/server/config.js';
import {migrate} from '../src/server/db.js';
import {createAuth,registerAuth,createRequireActor} from '../src/server/auth.js';
const databaseUrl=process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('Real Better Auth invite and role boundary',()=>{
 const schema=`auth_test_${randomUUID().replaceAll('-','')}`;
 const app=Fastify();let pool:Pool;let admin:Pool;let cookie='';
 const password='test-only-invited-buyer-password';const userId=randomUUID();
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});await migrate(pool);
  await pool.query('INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true)',[userId,'invited@test.invalid','Invited Buyer','buyer']);
  await pool.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',[randomUUID(),userId,await hashPassword(password)]);
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl!,BETTER_AUTH_SECRET:'auth-test-secret-with-more-than-32-characters',WICK_MODE:'fixture',MUSE_MODE:'fixture',APP_URL:'http://localhost:3000'});
  const auth=createAuth(config,pool);await registerAuth(app,auth,config);const requireActor=createRequireActor(auth,pool);
  app.get('/private',async req=>requireActor(req));app.get('/admin-only',async req=>requireActor(req,['admin']));await app.ready();
 });
 afterAll(async()=>{await app.close();if(pool)await pool.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
 it('rejects public account creation and cannot accept an admin role',async()=>{
  const response=await app.inject({method:'POST',url:'/api/auth/sign-up/email',payload:{name:'Uninvited',email:'uninvited@test.invalid',password,role:'admin'}});
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect((await pool.query('SELECT count(*)::int AS n FROM "user" WHERE email=$1',['uninvited@test.invalid'])).rows[0].n).toBe(0);
 });
 it('rejects incorrect credentials without issuing a session',async()=>{
  const response=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email:'invited@test.invalid',password:'incorrect-password'}});
  expect(response.statusCode).toBe(401);expect(response.headers['set-cookie']).toBeUndefined();
 });
 it('logs in an explicitly seeded account with an HttpOnly session and database role',async()=>{
  const response=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email:'invited@test.invalid',password}});
  expect(response.statusCode).toBe(200);
  const cookies=response.headers['set-cookie'];const lines=typeof cookies==='string'?[cookies]:cookies??[];
  expect(lines.some(c=>/httponly/i.test(c))).toBe(true);cookie=lines.map(c=>c.split(';')[0]).join('; ');
  const privateResponse=await app.inject({method:'GET',url:'/private',headers:{cookie}});
  expect(privateResponse.statusCode).toBe(200);expect(privateResponse.json().role).toBe('buyer');
  expect((await app.inject({method:'GET',url:'/admin-only',headers:{cookie}})).statusCode).toBe(403);
 });
 it('does not permit privilege escalation through user profile updates',async()=>{
  await app.inject({method:'POST',url:'/api/auth/update-user',headers:{cookie,origin:'http://localhost:3000'},payload:{name:'Buyer Updated',role:'admin',providerId:'spoofed'}});
  const user=(await pool.query('SELECT role,"providerId" FROM "user" WHERE id=$1',[userId])).rows[0];
  expect(user.role).toBe('buyer');expect(user.providerId).toBeNull();
 });
 it('revokes the same session immediately when logging out',async()=>{
  const result=await app.inject({method:'POST',url:'/api/auth/sign-out',headers:{cookie,origin:'http://localhost:3000'},payload:{}});expect(result.statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:'/private',headers:{cookie}})).statusCode).toBe(401);
 });
});
