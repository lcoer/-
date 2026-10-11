import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {levelsFromOcr,profileLevelRegion,readProfileLevels} from '../src/user-level.mjs';
import {readLevelDigits} from '../src/level-digits.cjs';
import {hiddenLevelSides} from '../src/level-hidden.mjs';
const n=(shortId,text='',extra={})=>({shortId,text,x:10,y:20,x2:30,y2:40,enabled:true,...extra});
const nodes=[n('','',{packageName:'com.sybl.voiceroom',x:0,y:0,x2:1080,y2:1920}),n('tv_nickname','A',{x:400,y:1300,x2:500,y2:1350}),n('tv_user_code','12345678'),n('tv_age','27',{x:620,y:1500,x2:660,y2:1540}),n('tv_online_status','在线',{x:400,y:1500,x2:460,y2:1540})];
const options={expectedUid:'12345678',expectedNickname:'A'};
test('OCR accepts only one bounded numeric/question token per level badge',()=>{
 const word=(text,x)=>({text,x,y:10,width:30,height:20});
 assert.deepEqual(levelsFromOcr([word('37',20),word('103',160)],300,60),{wealthLevel:37,charmLevel:103});
 assert.deepEqual(levelsFromOcr([word('37',20),word('38',70),word('103',160)],300,60),{charmLevel:103});
 assert.deepEqual(levelsFromOcr([word('27岁',20),word('VIP5',160),word('999',-10)],300,60),{});
 assert.deepEqual(levelsFromOcr([word('???',20),word('？？？',160)],300,60),{wealthLevel:'?',charmLevel:'?'});
 assert.deepEqual(levelsFromOcr([word('37',280),{...word('38',30),y:80}],300,60),{});
});
test('actual cropped hidden badges override OCR zero confusion; numeric badges do not',()=>{
 const hidden=fs.readFileSync(new URL('./fixtures/levels/hidden.png',import.meta.url)),numeric=fs.readFileSync(new URL('./fixtures/levels/numeric.png',import.meta.url));
 assert.deepEqual(hiddenLevelSides(hidden,{x:0,y:0,width:167,height:45}),[0,1]);
 assert.deepEqual(hiddenLevelSides(numeric,{x:0,y:0,width:180,height:41}),[]);
});
test('level region is identity verified and excludes nickname and age',()=>{
 const r=profileLevelRegion(nodes,'12345678','A');assert.ok(r);assert.ok(r.y>1350);assert.ok(r.y+r.height<1500);
 assert.equal(profileLevelRegion(nodes,'99999999','A'),null);
 assert.equal(profileLevelRegion(nodes,'12345678','B'),null);
});
test('accessible explicit level fields validate visibility and ignore next-level/age',async()=>{
 const r=await readProfileLevels({},[...nodes,n('tv_rich_level','LV.37'),n('tv_charm_level','???'),n('tv_next_rich_level','LV.54')],options);
 assert.equal(r.wealthLevel,37);assert.equal(r.charmLevel,'?');
 const hidden=await readProfileLevels({},[...nodes,n('tv_rich_level','54',{x:-20}),n('tv_age','103')],options);assert.equal(hidden.wealthLevel,undefined);
});
test('missing capture and cancellation never become hidden/high levels',async()=>{
 const r=await readProfileLevels({},nodes,options);assert.equal(r.wealthLevel,undefined);assert.equal(r.reason,'badge_unavailable');
 const ac=new AbortController();ac.abort();await assert.rejects(readProfileLevels({},nodes,{...options,signal:ac.signal}),{name:'AbortError'});
});
test('OCR never overrides visible explicit values and rejects identity changes after capture',async()=>{
 const png=fs.readFileSync(new URL('./fixtures/levels/numeric.png',import.meta.url));
 const current=[...nodes,n('tv_rich_level','54')];
 const driver={adb:{screenshotBuffer:async()=>png},bridge:{dumpUi:async()=>({nodes:current})}};
 const ocr=async()=>[{text:'37',x:10,y:10,width:40,height:30},{text:'103',x:900,y:10,width:70,height:30}];
 const result=await readProfileLevels(driver,current,{...options,ocr});
 assert.equal(result.wealthLevel,54);assert.equal(result.charmLevel,103);
 driver.bridge.dumpUi=async()=>({nodes:current.map(node=>node.shortId==='tv_user_code'?{...node,text:'99999999'}:node)});
 const changed=await readProfileLevels(driver,current,{...options,ocr});
 assert.equal(changed.wealthLevel,undefined);assert.equal(changed.reason,'identity_or_layout_changed');
});

test('digit templates read classification boundaries without inferring question marks as zero',()=>{
 const templates=JSON.parse(fs.readFileSync(new URL('../src/assets/levels/digits.json',import.meta.url)));
 const render=text=>{const width=220,height=60,data=new Uint8Array(width*height*4);for(let i=0;i<text.length;i++){const grid=templates.find(t=>t.digit===text[i]).grid;for(let y=0;y<24;y++)for(let x=0;x<16;x++)if(grid[y*16+x]==='1'){const p=((y+12)*width+x+15+i*22)*4;data[p]=data[p+1]=data[p+2]=data[p+3]=255;}}return {width,height,data};};
 for(const value of [0,53,54,71,201])assert.equal(readLevelDigits(render(String(value)),{x:0,y:0,width:220,height:60}).values.wealthLevel,value);
 const blank={width:220,height:60,data:new Uint8Array(220*60*4)};assert.deepEqual(readLevelDigits(blank,{x:0,y:0,width:220,height:60}).values,{});
});


test('independent actual upgraded purple wealth badge reads 71 without color categorization',()=>{
 const png=fs.readFileSync(new URL('./fixtures/levels/wealth-71.png',import.meta.url));
 assert.equal(readLevelDigits(png,{x:0,y:0,width:85,height:70}).values.wealthLevel,71);
});

test('actual zero-level numeral remains distinct from its diamond and heart icons',async()=>{
 const {decodePng}=await import('../src/gender-badge.cjs');
 const png=fs.readFileSync(new URL('./fixtures/levels/zero-84.png',import.meta.url)),roi={x:0,y:0,width:270,height:70};
 assert.equal(readLevelDigits(png,roi).values.wealthLevel,0);
 const image=decodePng(png);
 for(let y=0;y<image.height;y++)for(let x=60;x<image.width;x++)if(x<130||x>198){const p=(y*image.width+x)*4;image.data[p]=image.data[p+1]=image.data[p+2]=0;}
 assert.deepEqual(readLevelDigits(image,roi).values,{});
});

test('level capture uses fresh geometry after gender and retries one same-identity layout change',async()=>{
 const png=fs.readFileSync(new URL('./fixtures/levels/numeric.png',import.meta.url));
 const shift=(frame,offset)=>frame.map(node=>['tv_nickname','tv_age','tv_online_status'].includes(node.shortId)?{...node,y:node.y+offset,y2:node.y2+offset}:node);
 const moved=shift(nodes,40),settled=shift(nodes,80);let dumps=0,captures=0;const regions=[];
 const driver={adb:{screenshotBuffer:async()=>{captures++;return png;}},bridge:{dumpUi:async()=>({nodes:++dumps===1?moved:settled})}};
 const result=await readProfileLevels(driver,nodes,{...options,ocr:async(_png,roi)=>{regions.push(roi);return [{text:'12',x:100,y:20,width:60,height:40},{text:'33',x:900,y:20,width:60,height:40}];}});
 assert.equal(captures,2);assert.equal(result.wealthLevel,12);assert.equal(result.charmLevel,33);assert.equal(regions[0].y,profileLevelRegion(settled,options.expectedUid,options.expectedNickname).y);
});
test('foreign snapshot and cancelled layout retry never authorize level classification',async()=>{
 const png=fs.readFileSync(new URL('./fixtures/levels/numeric.png',import.meta.url));let captures=0;
 const driver={adb:{screenshotBuffer:async()=>{captures++;return png;}},bridge:{dumpUi:async()=>({nodes:nodes.map((n,i)=>i===0?{...n,packageName:'com.android.systemui'}:n)})}};
 const denied=await readProfileLevels(driver,nodes,options);assert.equal(denied.wealthLevel,undefined);assert.equal(captures,0);
 const controller=new AbortController();driver.bridge.dumpUi=async()=>{controller.abort();return {nodes};};
 await assert.rejects(readProfileLevels(driver,nodes,{...options,signal:controller.signal}),{name:'AbortError'});
});

test('complete public profile region anchors below ID/age and before signature',()=>{
 const full=[n('','',{packageName:'com.sybl.voiceroom',x:0,y:0,x2:1080,y2:1920}),n('tv_nickname','A',{x:147,y:847,x2:254,y2:924}),n('tv_user_code','12345678',{x:117,y:947,x2:245,y2:986}),n('tv_age','24',{x:366,y:949,x2:420,y2:988}),n('tv_sign','signature',{x:123,y:1099,x2:991,y2:1151}),n('iv_follow','',{x:58,y:1696,x2:441,y2:1834}),n('iv_chat','',{x:476,y:1696,x2:1023,y2:1834})];
 assert.deepEqual(profileLevelRegion(full,'12345678','A'),{x:54,y:1004,width:302,height:85});
 assert.equal(profileLevelRegion(full.filter(n=>n.shortId!=='iv_chat'),'12345678','A'),null);
 assert.equal(profileLevelRegion(full.map(n=>n.shortId==='tv_user_code'?{...n,shortId:'tv_nice_num'}:n),'12345678','A'),null);
});
test('independent full-profile cropped low numeral and hidden badges retain proper meanings',()=>{
 const roi={x:0,y:0,width:302,height:85};
 const low=fs.readFileSync(new URL('./fixtures/levels/full-low-0-84.png',import.meta.url));
 const hidden=fs.readFileSync(new URL('./fixtures/levels/full-hidden.png',import.meta.url));
 assert.equal(readLevelDigits(low,roi).values.wealthLevel,0);
 assert.deepEqual(hiddenLevelSides(low,roi),[]);
 assert.deepEqual(hiddenLevelSides(hidden,roi),[0,1]);
});
