import test from 'node:test';import assert from 'node:assert/strict';
import {profileIdentity} from '../src/profile-identity.mjs';
const n=(shortId,text='',extra={})=>({shortId,text,x:10,y:800,x2:100,y2:850,packageName:'com.sybl.voiceroom',...extra});
const card=[n('','',{x:0,y:759,x2:1080,y2:1920}),n('rv_top_bg'),n('iv_copy'),n('tv_nickname','17'),n('tv_nice_num','22217'),...['关注','送礼','私聊Ta'].map(text=>n('tv_user_operate_item',text))];
const expected={expectedNiceNumber:'22217',expectedNickname:'17'};
test('themed nice-number cards bind unverified attributes without inventing a UID',()=>{
 assert.equal(profileIdentity(card,expected)?.kind,'nice_number');
 assert.equal(profileIdentity(card,{expectedUid:'22217',expectedNickname:'17'}),null);
});
test('missing anchors, changed name/number and foreign or hidden cards are refused',()=>{
 for(const nodes of [card.filter(n=>n.shortId!=='iv_copy'),card.map(n=>n.shortId==='tv_nice_num'?{...n,text:'33333'}:n),card.map(n=>n.shortId==='tv_nickname'?{...n,text:'other'}:n),card.map((n,i)=>i===0?{...n,packageName:'other.app'}:n),card.map(n=>n.shortId==='tv_nice_num'?{...n,x2:0}:n)])assert.equal(profileIdentity(nodes,expected),null);
 assert.equal(profileIdentity([...card,n('tv_user_code','23581742')],expected),null);
 assert.equal(profileIdentity(card,{...expected,expectedUid:'22217'}),null);
});
