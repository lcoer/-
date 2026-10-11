const fs=require('node:fs'),path=require('node:path'),{decodePng}=require('./gender-badge.cjs');
let templates;
function glyphs(im,roi){const mask=(x,y)=>{const p=(y*im.width+x)*4;return im.data[p]>225&&im.data[p+1]>225&&im.data[p+2]>225;};let segments=[];
for(let x=roi.x;x<roi.x+roi.width;x++){let count=0;for(let y=roi.y;y<roi.y+roi.height;y++)if(mask(x,y))count++;if(count>=2){if(!segments.length||x-segments.at(-1).at(-1)>1)segments.push([]);segments.at(-1).push(x);}}
for(let i=0;i<segments.length-1;i++)if(segments[i].length<4&&segments[i+1][0]-segments[i].at(-1)<=4){segments[i].push(...segments[i+1]);segments.splice(i+1,1);}
return segments.map(seg=>{let top=Infinity,bottom=0;const left=seg[0],right=seg.at(-1)+1;for(let y=roi.y;y<roi.y+roi.height;y++)for(let x=left;x<right;x++)if(mask(x,y)){top=Math.min(top,y);bottom=Math.max(bottom,y+1);}const w=right-left,h=bottom-top;let grid='';for(let y=0;y<24;y++)for(let x=0;x<16;x++){const px=Math.min(right-1,left+Math.floor((x+.5)*w/16)),py=Math.min(bottom-1,top+Math.floor((y+.5)*h/24));grid+=mask(px,py)?'1':'0';}return {grid,x:left,y:top,width:w,height:h};});}
function readLevelDigits(png,roi){
 const im=Buffer.isBuffer(png)?decodePng(png):png;if(!roi||![roi.x,roi.y,roi.width,roi.height].every(Number.isInteger)||roi.x<0||roi.y<0||roi.width<1||roi.height<1||roi.x+roi.width>im.width||roi.y+roi.height>im.height)return {};
 templates ||= JSON.parse(fs.readFileSync(path.join(__dirname,'assets/levels/digits.json'),'utf8'));
 const found=[],raw=glyphs(im,roi);
 for(const glyph of raw){
  if(glyph.height<9||glyph.height>roi.height*.7||glyph.width<3||glyph.width>glyph.height*1.1)continue;
  const scores=new Map();for(const t of templates){let equal=0,union=0,intersection=0;for(let i=0;i<t.grid.length;i++){if(t.grid[i]===glyph.grid[i])equal++;if(t.grid[i]==='1'||glyph.grid[i]==='1')union++;if(t.grid[i]==='1'&&glyph.grid[i]==='1')intersection++;}const score=.5*equal/t.grid.length+.5*intersection/Math.max(1,union);scores.set(t.digit,Math.max(scores.get(t.digit)||0,score));}
  const ranked=[...scores].sort((a,b)=>b[1]-a[1]);
  if(ranked[0][1]>=.79&&ranked[0][1]-ranked[1][1]>=.045)found.push({...glyph,digit:ranked[0][0],score:ranked[0][1]});
 }
 const result={};for(let side=0;side<2;side++){
  const candidates=raw.filter(g=>g.height>=9&&g.width>=3&&g.width<=g.height*1.1&&(g.x+g.width/2<roi.x+roi.width/2?0:1)===side).sort((a,b)=>b.x-a.x);
  if(!candidates.length)continue;
  const group=[candidates[0]];
  for(let i=1;i<candidates.length&&group.length<4;i++){const previous=group.at(-1),candidate=candidates[i],h=Math.max(previous.height,candidate.height);if(previous.x-(candidate.x+candidate.width)>Math.min(previous.height,candidate.height)*.8||Math.min(previous.height,candidate.height)/h<.65||Math.abs(previous.y+previous.height-candidate.y-candidate.height)>h*.25)break;group.push(candidate);}
  if(group.length>3)continue;
  const chars=group.reverse().map(c=>found.find(g=>g.x===c.x));
  if(chars.some(c=>!c))continue;  result[side===0?'wealthLevel':'charmLevel']=Number(chars.map(c=>c.digit).join(''));
 }
 return {values:result,glyphs:found};
}
module.exports={readLevelDigits};
