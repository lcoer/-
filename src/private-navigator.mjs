import { abortableSleep, throwIfAborted } from './async-control.mjs';
import { RoomNavigator, isRoomPasswordGate } from './room-navigator.mjs';

const PACKAGE = 'com.sybl.voiceroom';
const inside = (node, parent) => node.x >= parent.x && node.y >= parent.y && node.x2 <= parent.x2 && node.y2 <= parent.y2;
const numeric = text => /^\(?\d+\)?$/.test((text || '').trim()) ? text.trim().replace(/[()]/g, '') : null;

/** Find a user by exact UID through the observed search/profile/chat screens. */
export class PrivateNavigator {
  constructor(driver, {signal, onLog = () => {}, timeoutMs = 6000, pollIntervalMs = 180, actionGapMs = 1800} = {}) {
    this.driver = driver;
    this.signal = signal;
    this.onLog = onLog;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.actionGapMs = actionGapMs;
    this.lastActionAt = 0;
    this.size = null;
    this.peer = null;
  }
  async _snapshot() {
    throwIfAborted(this.signal);
    const {nodes} = await this.driver.bridge.dumpUi({signal:this.signal});
    throwIfAborted(this.signal);
    const root = nodes[0];
    if (root?.packageName !== PACKAGE) throw Error('PRIVATE_WRONG_PACKAGE');
    this.rawNodes = nodes;
    if (/FrameLayout|View$/.test(root.className || '') && root.x === 0 && root.y >= 0 &&
      root.y < root.y2 && Number.isFinite(root.x2) && Number.isFinite(root.y2) && root.x2 >= 320 && root.y2 >= 320)
      this.size = {w:root.x2,h:root.y2};
    if (!this.size) this.size = await this.driver.adb.screenSize();
    throwIfAborted(this.signal);
    return nodes.filter(n => n.packageName === PACKAGE && n.enabled !== false &&
      [n.x,n.y,n.x2,n.y2].every(Number.isFinite) && n.x >= 0 && n.y >= 0 &&
      n.x2 <= this.size.w && n.y2 <= this.size.h && n.x2 > n.x && n.y2 > n.y);
  }
  _unique(nodes, id) {
    const matches = nodes.filter(n => n.shortId === id);
    return matches.length === 1 ? matches[0] : null;
  }
  async _wait(predicate, reason) {
    const deadline = Date.now() + this.timeoutMs;
    do {
      const nodes = await this._snapshot();
      const result = predicate(nodes);
      if (result) return result;
      if (Date.now() >= deadline) break;
      await abortableSleep(Math.min(this.pollIntervalMs, Math.max(1,deadline-Date.now())),this.signal);
    } while (Date.now() <= deadline);
    throw Error(reason);
  }
  async _tap(node, {validate} = {}) {
    throwIfAborted(this.signal);
    if (!node) throw Error('PRIVATE_CONTROL_NOT_FOUND');
    await abortableSleep(Math.max(0,this.actionGapMs-(Date.now()-this.lastActionAt)),this.signal);
    const fresh=await this._snapshot();
    if(validate&&!validate(fresh))throw Error('PRIVATE_CONTEXT_CHANGED');
    const matches=fresh.filter(n=>n.shortId===node.shortId&&n.text===node.text);
    if(matches.length!==1)throw Error('PRIVATE_CONTROL_CHANGED');
    node=matches[0];
    let result;
    // Android can consume a physical click while the search EditText changes
    // focus. A unique observed resource ID invokes the actual control action.
    // Count raw nodes as well, so an offscreen duplicate cannot be chosen.
    if (node.shortId && this.rawNodes?.filter(n=>n.shortId===node.shortId).length===1 && typeof this.driver.bridge.tapById==='function')
      result=await this.driver.bridge.tapById(node.shortId,{signal:this.signal});
    else if (typeof this.driver.bridge.tapByCoord==='function')
      result=await this.driver.bridge.tapByCoord((node.x+node.x2)/2,(node.y+node.y2)/2,{signal:this.signal});
    else
      await this.driver.adb.tap((node.x+node.x2)/2,(node.y+node.y2)/2);
    throwIfAborted(this.signal);
    if(result && result.ok!==true)throw Error(`PRIVATE_CLICK_UNCONFIRMED: ${result.error||'UNKNOWN'}`);
    this.lastActionAt=Date.now();
    return result;
  }
  async _back() {
    throwIfAborted(this.signal);
    const controls=this.rawNodes?.filter(n=>n.shortId==='iv_back')||[];
    if(controls.length===1 && typeof this.driver.bridge.tapById==='function')return this._tap(controls[0]);
    await this.driver.adb.back();
    throwIfAborted(this.signal);
  }
  _profile(nodes) {
    // tv_nice_num is accepted only on this full profile (iv_copy + iv_chat +
    // iv_follow), never as general room/card identity evidence.
    if (!this._unique(nodes,'iv_chat') || !this._unique(nodes,'iv_follow') ||
      !(this._unique(nodes,'iv_copy') || this._unique(nodes,'ll_copy')) || nodes.some(n => ['et_search','input_message'].includes(n.shortId))) return null;
    const nickname = this._unique(nodes,'tv_nickname')?.text?.trim();
    const realCodes=nodes.filter(n=>n.shortId==='tv_user_code');
    const codes=realCodes.length?realCodes:nodes.filter(n=>n.shortId==='tv_nice_num');
    if (!nickname || codes.length!==1 || !numeric(codes[0].text)) return null;
    if(!realCodes.length&&!this._unique(nodes,'iv_copy'))return null;
    return {uid:numeric(codes[0].text),nickname,nodes};
  }
  _chat(nodes, nickname) {
    return !!this._unique(nodes,'input_message') && !!this._unique(nodes,'iv_send') &&
      !!this._unique(nodes,'iv_back') && this._unique(nodes,'tv_nickname')?.text?.trim() === nickname &&
      !nodes.some(n => ['iv_chat','et_search','rv_top_bg'].includes(n.shortId));
  }
  async _home() {
    for (let step=0;step<6;step++) {
      let nodes = await this._snapshot();
      if (nodes.length === 1 && !nodes[0].shortId && !nodes[0].text)
        nodes = await this._wait(ns => ns.length > 1 ? ns : null,'APP_LOADING_TIMEOUT');
      if (isRoomPasswordGate(nodes)) {
        const home = await new RoomNavigator(this.driver,{signal:this.signal,entryTimeoutMs:this.timeoutMs,pollIntervalMs:this.pollIntervalMs}).returnHome();
        if (!home) throw Error('PRIVATE_RETURN_HOME_FAILED');
        continue;
      }
      const tab = this._unique(nodes,'ll_tab_home');
      if (tab) {
        if (this._unique(nodes,'iv_search')) return nodes;
        await this._tap(tab);
        return this._wait(ns => this._unique(ns,'ll_tab_home') && this._unique(ns,'iv_search') ? ns : null,'USER_SEARCH_UNAVAILABLE');
      }
      if (nodes.some(n => n.shortId === 'iv_quit' || n.shortId === 'rv_top_bg' ||
        n.shortId === 'tvTitle' && /^房间在线用户[（(]\d+人[)）]$/.test(n.text || ''))) {
        const home = await new RoomNavigator(this.driver,{signal:this.signal,entryTimeoutMs:this.timeoutMs,pollIntervalMs:this.pollIntervalMs}).returnHome();
        if (!home) throw Error('PRIVATE_RETURN_HOME_FAILED');
        continue;
      }
      const knownPage = this._unique(nodes,'iv_back') &&
        (this._unique(nodes,'et_search') || this._unique(nodes,'input_message') || this._profile(nodes));
      if (!knownPage) throw Error('PRIVATE_NAVIGATION_UNRECOGNIZED_PAGE');
      await this._back();
      await abortableSleep(this.pollIntervalMs,this.signal);
    }
    throw Error('PRIVATE_RETURN_HOME_FAILED');
  }
  _userResult(nodes, uid) {
    const candidates = [];
    for (const code of nodes.filter(n => ['tv_nice_num','tv_user_code'].includes(n.shortId) && numeric(n.text) === uid)) {
      const rows = nodes.filter(n => n.clickable && inside(code,n) &&
        nodes.some(name => name.shortId === 'tv_name' && name.text?.trim() && inside(name,n)))
        .sort((a,b) => (a.x2-a.x)*(a.y2-a.y)-(b.x2-b.x)*(b.y2-b.y));
      const row = rows[0];
      if (!row || nodes.some(n => n.shortId === 'tv_room_name' && inside(n,row))) continue;
      const names = nodes.filter(n => n.shortId === 'tv_name' && n.text?.trim() && inside(n,row));
      const codes = nodes.filter(n => ['tv_nice_num','tv_user_code'].includes(n.shortId) && inside(n,row));
      const realCodes=codes.filter(n=>n.shortId==='tv_user_code');
      const identity=realCodes.length?realCodes:codes;
      if (names.length !== 1 || identity.length !== 1) throw Error('AMBIGUOUS_USER_RESULT');
      if(numeric(identity[0].text)!==uid)continue;
      if(!candidates.includes(names[0]))candidates.push(names[0]);
    }
    if (candidates.length > 1) throw Error('AMBIGUOUS_USER_RESULT');
    return candidates[0] || null;
  }
  _checkUid(profile, uid) {
    if (profile.uid !== uid) {
      const error = Error(`UID_MISMATCH: expected ${uid}, actual ${profile.uid}`);
      error.actualUid = profile.uid;
      throw error;
    }
  }
  async returnHome() {
    return this._home();
  }
  async open(uid) {
    uid = String(uid || '');
    if (!/^\d+$/.test(uid)) throw Error('EXPECTED_UID_REQUIRED');
    throwIfAborted(this.signal);
    this.peer = null;
    this.onLog('info', `正在按用户ID查找: ${uid}`);
    const home = await this._home();
    await this._tap(this._unique(home,'iv_search'));
    await this._wait(ns => this._unique(ns,'et_search') && this._unique(ns,'tv_search') ? ns : null,'USER_SEARCH_UNAVAILABLE');
    const set = await this.driver.bridge.setText('et_search',uid,{signal:this.signal});
    throwIfAborted(this.signal);
    if (!set?.ok) throw Error(`SEARCH_INPUT_FAILED: ${set?.error || 'UNCONFIRMED'}`);
    const ready = await this._wait(ns => this._unique(ns,'et_search')?.text === uid && this._unique(ns,'tv_search') ? ns : null,'SEARCH_INPUT_MISMATCH');
    await this._tap(this._unique(ready,'tv_search'));
    const results = await this._wait(ns => this._unique(ns,'et_search')?.text === uid &&
      this._unique(ns,'tv_cancel') && ns.some(n => n.text === '用户' && n.clickable) ? ns : null,'USER_SEARCH_RESULTS_UNAVAILABLE');
    const tabs = results.filter(n => n.text === '用户' && n.clickable);
    if (tabs.length !== 1) throw Error('AMBIGUOUS_USER_TAB');
    await this._tap(tabs[0]);
    const result = await this._wait(ns => {
      if (this._unique(ns,'et_search')?.text !== uid || !this._unique(ns,'tv_cancel')) throw Error('SEARCH_CONTEXT_CHANGED');
      if (ns.some(n => ['暂无数据','暂无相关用户','未找到相关用户','暂无搜索结果','暂无用户'].includes(n.text))) throw Error(`USER_NOT_FOUND: ${uid}`);
      return this._userResult(ns,uid);
    },`USER_NOT_FOUND: ${uid}`);
    await this._tap(result);
    const profile = await this._wait(ns => this._profile(ns),'PROFILE_UID_UNREADABLE');
    this._checkUid(profile,uid);
    this.onLog('info', `已核对用户 ${profile.nickname} (${uid})，正在打开私聊`);
    await this._tap(this._unique(profile.nodes,'iv_chat'));
    let chat = await this._wait(ns => this._chat(ns,profile.nickname) ? ns : null,'PRIVATE_CHAT_UNAVAILABLE');
    const peerControl = this._unique(chat,'tv_check') || this._unique(chat,'iv_avatar_target') || this._unique(chat,'iv_avatar_target_2');
    await this._tap(peerControl);
    const peer = await this._wait(ns => this._profile(ns),'PEER_PROFILE_UID_UNREADABLE');
    this._checkUid(peer,uid);
    await this._back();
    await this._wait(ns => this._chat(ns,peer.nickname) ? ns : null,'PRIVATE_CHAT_RESTORE_FAILED');
    this.peer = {uid,nickname:peer.nickname};
    return {...this.peer};
  }
  async readChat() {
    const nodes = await this._snapshot();
    if (!this.peer || !this._chat(nodes,this.peer.nickname)) throw Error('CHAT_CONTEXT_CHANGED');
    return {nodes};
  }
  async clickSend(text) {
    const {nodes}=await this.readChat();
    return this._tap(this._unique(nodes,'iv_send'),{validate:ns=>this.peer&&this._chat(ns,this.peer.nickname)&&this._unique(ns,'input_message')?.text===text});
  }
}
