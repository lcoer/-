const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {classifyUsers}=require('../src/user-classification.cjs');
const args=process.argv.slice(2),allowed=new Set(['--input','--output','--gender-field','--level-field','--date']);
const opts={};for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error(`Invalid argument: ${args[i]}`);opts[args[i]]=args[i+1];}
const dataDir=process.env.SYBL_USER_DATA_DIR||path.join(process.env.APPDATA||process.cwd(),'shuangyu-assistant');
const input=path.resolve(opts['--input']||path.join(dataDir,'records-v2.json'));
const output=path.resolve(opts['--output']||path.join(__dirname,'..','exports','user-classification',new Date().toISOString().replace(/[:.]/g,'-')));
const bytes=fs.readFileSync(input),dataset=JSON.parse(bytes.toString('utf8'));
if(dataset.schemaVersion!==2||!Array.isArray(dataset.records))throw Error('INVALID_DATASET: Expected records-v2.json schemaVersion 2');
if(path.dirname(input)===output)throw Error('OUTPUT_MUST_BE_SEPARATE_FROM_SOURCE');
const result=classifyUsers(dataset.records,{genderField:opts['--gender-field']||'sex',levelField:opts['--level-field']||null,date:opts['--date']||null});
result.dataset={path:input,sha256:createHash('sha256').update(bytes).digest('hex'),schemaVersion:2,recordCount:dataset.records.length};
result.generatedAt=new Date().toISOString();
fs.mkdirSync(output,{recursive:true});
// Store a byte-identical source snapshot so row indexes remain traceable after
// the application's live file changes. New output names never overwrite it.
const snapshot=path.join(output,'source-records.json');fs.writeFileSync(snapshot,bytes,{flag:'wx'});
result.dataset.snapshot=snapshot;
fs.writeFileSync(path.join(output,'classification.json'),JSON.stringify(result,null,2),'utf8');
const csv=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
const lines=[['gender','level','userCount','unverifiedCount','observationCount'],...result.groups.map(g=>[g.gender,g.level,g.userCount,g.unverifiedCount,g.observationCount])];
fs.writeFileSync(path.join(output,'summary.csv'),'\uFEFF'+lines.map(row=>row.map(csv).join(',')).join('\r\n')+'\r\n','utf8');
console.log(JSON.stringify({output,fields:result.fields,totals:result.totals,groups:result.groups.map(({detailIndexes,...summary})=>summary),warnings:result.warnings},null,2));
