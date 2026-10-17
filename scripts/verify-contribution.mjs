// Explicit public navigation; isolated output only. No messaging/following/gifting.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {AndroidDriver} from '../src/android-driver.mjs';
import {RoomCollector} from '../src/room-collector.mjs';
const require=createRequire(import.meta.url);
if(!process.argv.includes('--navigate'))throw Error('Use --navigate to allow public room/rank/profile navigation');
const {createDataStore}=require('../electron/services/data-store');
const output=path.resolve('tmp/contribution-verification');fs.mkdirSync(output,{recursive:true});
const store=createDataStore({dataDir:output,persist:true});store.init();
const driver=new AndroidDriver();
await driver.ensureReady();
await driver.bridge.ensureCompatible();
const collector=new RoomCollector(driver,{collectionSource:'dailyContribution',scope:'single',maxPages:3,maxProfiles:3,onUsers:(users,meta)=>store.ingestRealRecords(users,meta),onLog:(level,message)=>console.log(level,message)});
const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),150000);
try{
 collector.signal=abort.signal;collector.stopped=false;driver.setSignal(abort.signal);
 collector.navigator=collector._makeNavigator();
 await collector._collectOnce();
 const report={...collector.getStatus(),output,actualPublicNavigation:true,sentMessages:0};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
 if(report.rounds!==1||report.uniqueVerified<1||report.memberStatus==='unavailable'||report.profileStatus==='room_restore_failed')process.exitCode=1;
}finally{clearTimeout(timer);collector.stopped=true;driver.setSignal(undefined);}
