import {randomUUID} from 'node:crypto';
import {hashPassword} from 'better-auth/crypto';
import {loadConfig} from '../src/server/config.js';
import {createPool,migrate,transaction} from '../src/server/db.js';
import {createWickAdapter} from '../src/server/integrations/wick.js';
import {seedMarketplace} from '../src/server/marketplace/index.js';
import type {Actor,Role} from '../src/shared/types.js';
const config=loadConfig();
const accounts:[string,string,string,Role][]=[['BUYER','buyer@demo.wick.local','Alex Morgan','buyer'],['SUPPLIER_A','supplier-a@demo.wick.local','Supplier A','provider'],['SUPPLIER_B','supplier-b@demo.wick.local','Supplier B','provider'],['SUPPLIER_C','supplier-c@demo.wick.local','Supplier C','provider'],['ADMIN','admin@demo.wick.local','Wick Admin','admin']];
const prepared=await Promise.all(accounts.map(async([key,email,name,role])=>{
 const password=process.env[`SEED_${key}_PASSWORD`];
 if(!password||password.length<12)throw new Error(`SEED_${key}_PASSWORD must be supplied with at least 12 characters. No default passwords are provided.`);
 return {id:randomUUID(),email:process.env[`SEED_${key}_EMAIL`]||email,name,role,password:await hashPassword(password)};
}));
const pool=createPool(config.databaseUrl);
try{
 await migrate(pool);
 const actors=await transaction(pool,async c=>{
  const actors:Actor[]=[];
  for(const account of prepared){
   const {rows}=await c.query('INSERT INTO "user"(id,email,name,role,"emailVerified") VALUES($1,$2,$3,$4,true) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role,"updatedAt"=now() RETURNING id,email,name,role',[account.id,account.email,account.name,account.role]);
   const actor=rows[0] as Actor;
   await c.query('INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3) ON CONFLICT("providerId","accountId") DO UPDATE SET password=EXCLUDED.password,"updatedAt"=now()',[randomUUID(),actor.id,account.password]);
   actors.push(actor);
  }
  return actors;
 });
 const catalog=await createWickAdapter(config,pool).catalog();
 await seedMarketplace(pool,actors,catalog);
 await pool.query('UPDATE "user" u SET "providerId"=p.id FROM broker_providers p WHERE p.user_id=u.id');
 console.log(`Seeded ${actors.length} invited accounts. Supplier supply is simulated demo inventory. Wick=${config.wickMode}, Muse=${config.museMode}. Passwords remain in your environment.`);
 for(const actor of actors)console.log(`${actor.role}: ${actor.email}`);
}finally{await pool.end();}
