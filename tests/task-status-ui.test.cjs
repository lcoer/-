const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function setup(){
 const elements=new Map(),callbacks=[];
 const get=id=>{if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,classList:{toggle(){}},addEventListener(){},querySelector(){return null;}});return elements.get(id);};
 const stopped={state:'stopped',running:false,stats:{}};
 const context=vm.createContext({window:{api:{task:{onLog(){},onStatus:fn=>callbacks.push(fn),getStatus:async()=>({statusRevision:0,private:stopped,welcome:stopped,call:stopped,deviceOwner:null})}}},document:{getElementById:get}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../design/js/task-console.js'),'utf8')+'\nthis.TaskConsole=TaskConsole',context);
 return {get,callbacks,init:()=>context.TaskConsole.init(),stopped};
}
test('late private stopping event cannot override a newer stopped state and device release',async()=>{
 const h=setup();await h.init();const update=h.callbacks[0];
 update({statusRevision:3,private:h.stopped,welcome:h.stopped,call:h.stopped,deviceOwner:null});
 update({statusRevision:2,private:{state:'stopping',running:true,stats:{}},welcome:h.stopped,call:h.stopped,deviceOwner:{owner:'private'}});
 assert.equal(h.get('taskPrivateText').textContent,'已停止');assert.equal(h.get('taskPrivateStart').disabled,false);assert.equal(h.get('taskPrivateStop').disabled,true);
});
