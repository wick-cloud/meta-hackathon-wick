import {loadConfig} from './config.js';
import {buildApp} from './app.js';
const config=loadConfig();
const {app}=await buildApp(config);
await app.listen({host:config.host,port:config.port});
app.log.info({wick:config.wickMode,muse:config.museMode},'Wick Broker ready; supplier inventory and customer invoices are demo-only');
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,async()=>{if(stopping)return;stopping=true;const timer=setTimeout(()=>process.exit(1),25000);timer.unref();try{await app.close();clearTimeout(timer);process.exit(0);}catch{process.exit(1);}});
