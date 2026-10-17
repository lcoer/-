const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function harness(){
 const elements=new Map(),notices=[];
 const get=id=>{if(!elements.has(id)){const handlers={};elements.set(id,{value:'',innerHTML:'',textContent:'',disabled:false,addEventListener:(type,fn)=>handlers[type]=fn,fire:(type,event)=>handlers[type]?.(event)});}return elements.get(id);};
 get('recommendGroupFilter').value='all';get('recommendLevelField').value='wealthLevel';
 const settings={levelField:'wealthLevel',threshold:54},users=[{uid:'101',nickname:'<script>test</script>',sex:'female',group:'high',original:{wealthLevel:54}},{uid:'102',nickname:'low',sex:'male',group:'low',original:{wealthLevel:53}},{uid:'103',nickname:'hidden',group:'high',levelHidden:true,original:{wealthLevel:'???'}}];
 const list=async()=>({ok:true,...settings,settings,users,counts:{high:2,low:1,unclassified:0,total:3}});
 const context=vm.createContext({window:{api:{recommendation:{list}}},document:{getElementById:get},notices,toast:text=>notices.push(text)});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../design/js/utils.js'),'utf8'),context);
 vm.runInContext('toast=text=>notices.push(text)',context);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../design/js/recommendation-view.js'),'utf8')+'\nthis.view=RecommendationView;',context);
 return {get,notices,view:context.view};
}
test('console list keeps classification, escaped details and explicit selection across groups',async()=>{
 const h=harness();await h.view.init();assert.equal(h.get('recommendThreshold').value,'54');assert.equal(h.get('recommendHighCount').textContent,2);
 assert.match(h.get('recommendRows').innerHTML,/&lt;script&gt;/);assert.match(h.get('recommendRows').innerHTML,/隐藏/);
 assert.match(h.get('recommendRows').innerHTML,/checkbox/);assert.equal(h.view.assign,undefined);assert.throws(()=>h.view.getSelection(),/勾选/);
 h.get('recommendGroupFilter').value='high';h.get('recommendGroupFilter').fire('change');assert.doesNotMatch(h.get('recommendRows').innerHTML,/data-uid="102"/);
 h.get('recommendSelectAllBtn').fire('click');assert.deepEqual(Array.from(h.view.getSelection().uids),['101','103']);
 h.get('recommendGroupFilter').value='low';h.get('recommendGroupFilter').fire('change');h.get('recommendSelectAllBtn').fire('click');assert.equal(h.view.getSelection().uids.length,3);
 h.view.setBusy(true);h.get('recommendClearBtn').fire('click');assert.equal(h.view.getSelection().uids.length,3);h.view.setBusy(false);await h.view.refresh();assert.equal(h.view.getSelection().uids.length,3);h.get('recommendClearBtn').fire('click');assert.throws(()=>h.view.getSelection(),/勾选/);
});
test('invalid threshold is rejected, valid classification remains editable, removed controls stay absent',async()=>{
 const h=harness();await h.view.init();h.get('recommendThreshold').value='';await h.view.saveClassification();assert.match(h.notices.at(-1),/非负整数/);
 h.get('recommendThreshold').value='54';await h.view.saveClassification();assert.equal(h.get('recommendRefreshBtn').disabled,false);
 const html=fs.readFileSync(path.join(__dirname,'../design/index.html'),'utf8');assert.doesNotMatch(html,/data-view="recommendation"|recommendContent|recommendAssignBtn|recommendAssignments/);assert.match(html,/recommendSelectAllBtn/);
});
