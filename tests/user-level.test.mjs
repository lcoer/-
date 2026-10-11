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
