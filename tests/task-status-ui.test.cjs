const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function setup(){
 const elements=new Map(),callbacks=[];
 const get=id=>{assert.doesNotMatch(id,/^task(?:Welcome|Call)/,'removed task DOM must not be accessed');if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,classList:{toggle(){}},addEventListener(){},querySelector(){return null;}});return elements.get(id);};
 const stopped={state:'stopped',running:false,stats:{}};
 const context=vm.createContext({window:{api:{task:{onLog(){},onStatus:fn=>callbacks.push(fn),getStatus:async()=>({statusRevision:0,private:stopped,deviceOwner:null})}}},document:{getElementById:get}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../design/js/task-console.js'),'utf8')+'\nthis.TaskConsole=TaskConsole',context);
 return {get,callbacks,init:()=>context.TaskConsole.init(),stopped};
}
test('late private stopping event cannot override a newer stopped state and device release',async()=>{
 const h=setup();await h.init();const update=h.callbacks[0];
 update({statusRevision:3,private:h.stopped,deviceOwner:null});
 update({statusRevision:2,private:{state:'stopping',running:true,stats:{}},deviceOwner:{owner:'private'}});
 assert.equal(h.get('taskPrivateText').textContent,'已停止');assert.equal(h.get('taskPrivateStart').disabled,false);assert.equal(h.get('taskPrivateStop').disabled,true);
});

test('private delay is shown as waiting with its next target rather than an unexplained running state',async()=>{
 const h=setup();await h.init();h.callbacks[0]({statusRevision:1,private:{state:'running',running:true,stats:{phase:'waiting',waitMs:15000,nextTargetUid:'23456'}},deviceOwner:{owner:'private'}});
 assert.match(h.get('taskPrivateText').textContent,/等待间隔 15 秒/);assert.match(h.get('taskPrivateText').textContent,/23456/);assert.equal(h.get('taskPrivateStop').disabled,false);
});

 test('console markup keeps private controls and log after removing room action cards',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../design/index.html'),'utf8');
 assert.doesNotMatch(html,/task(?:Welcome|Call)|data-task="(?:welcome|call)"|class="task-grid"/);
 for(const id of ['taskPrivateStart','taskPrivateStop','pendingReviewBtn','taskLogList'])assert.ok(html.includes('id="'+id+'"'),id+' remains available');
 });
