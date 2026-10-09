const id=n=>n.shortId||String(n.resourceId||'').split('/').pop();
// Recognition authorizes closing this observed popup only. Its nice number
// does not become identity evidence for collection or private messaging.
export function isOperationRoomCard(nodes) {
  const one=name=>{const values=nodes.filter(n=>id(n)===name);return values.length===1?values[0]:null;};
  if(!one('rv_top_bg')||!one('iv_copy')||!one('tv_nickname')?.text?.trim()||!/^\d+$/.test(one('tv_nice_num')?.text||''))return false;
  const actions=nodes.filter(n=>id(n)==='tv_user_operate_item');
  return ['关注','送礼','私聊Ta'].every(text=>actions.filter(n=>n.text===text).length===1);
}
