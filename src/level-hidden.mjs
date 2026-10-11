import {decodePng} from './gender-badge.cjs';
// Hidden-level glyphs have a disconnected dot under a hook; require repeated
// question marks so OCR mistaking "???" for "000" cannot classify them as zero.
export function hiddenLevelSides(png,roi){
 const im=decodePng(png),components=[],seen=new Set();
 if(!roi||![roi.x,roi.y,roi.width,roi.height].every(Number.isInteger)||roi.x<0||roi.y<0||roi.width<1||roi.height<1||roi.x+roi.width>im.width||roi.y+roi.height>im.height)return [];
 const white=(x,y)=>{const p=(y*im.width+x)*4;return im.data[p]>225&&im.data[p+1]>225&&im.data[p+2]>225;};
 for(let y=roi.y;y<roi.y+roi.height;y++)for(let x=roi.x;x<roi.x+roi.width;x++){
  const k=y*im.width+x;if(seen.has(k)||!white(x,y))continue;const queue=[[x,y]],box={x,y,x2:x+1,y2:y+1};seen.add(k);
  for(let at=0;at<queue.length;at++){const [cx,cy]=queue[at];box.x=Math.min(box.x,cx);box.y=Math.min(box.y,cy);box.x2=Math.max(box.x2,cx+1);box.y2=Math.max(box.y2,cy+1);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
   const nx=cx+dx,ny=cy+dy,nk=ny*im.width+nx;if(nx<roi.x||nx>=roi.x+roi.width||ny<roi.y||ny>=roi.y+roi.height||seen.has(nk)||!white(nx,ny))continue;seen.add(nk);queue.push([nx,ny]);
  }}
  components.push(box);
 }
 const result=[];
 for(let side=0;side<2;side++){
  const hooks=components.filter(c=>{const h=c.y2-c.y,w=c.x2-c.x;return h>=6&&h<=roi.height*.65&&w>=h*.4&&w<=h*1.4&&((c.x+c.x2)/2<roi.x+roi.width/2?0:1)===side;});
  const pairs=hooks.filter(c=>components.some(d=>{const h=c.y2-c.y,w=c.x2-c.x;return d.y>c.y2+h*.15&&d.y<c.y2+h*.85&&d.x>=c.x-w*.1&&d.x2<=c.x2+w*.1&&d.x2-d.x<=w*.5&&d.y2-d.y<=h*.35;}));
  if(pairs.length>=2&&Math.max(...pairs.map(p=>p.y))-Math.min(...pairs.map(p=>p.y))<3)result.push(side);
 }return result;
}
