import { abortableSleep, throwIfAborted, isAbortError } from './async-control.mjs';
import { isOperationRoomCard } from './room-card.mjs';
const PACKAGE = 'com.sybl.voiceroom';
const inside = (node, parent) => node.x >= parent.x && node.y >= parent.y && node.x2 <= parent.x2 && node.y2 <= parent.y2;
export function isRoomPasswordGate(nodes) {
  const contentIds = ['nickname', 'tv_nickname', 'content', 'tv_bubble_content', 'tv_room_name', 'rc_text', 'input_message'];
  const prompt = nodes.some(node => !contentIds.includes(node.shortId) &&
    /^(?:(?:请)?输入房间密码|请输入密码(?:进入|加入)房间|房间密码|(?:该|此)?房间(?:需要|需输入|已设置)密码|(?:进入|加入)房间需要密码)[：:！!。]?$/u.test((node.text || '').trim()));
  return prompt && nodes.some(node => /EditText$/.test(node.className || '') ||
    /^(?:et_password|et_room_password|edit_password|input_password)$/.test(node.shortId || ''));
}
/** Navigate only observed room/home controls. One click is one attempt, never a retry. */
export class RoomNavigator {
  constructor(driver, { signal, onLog = () => {
  }, maxRooms = 12, knownRoomNames = [], entryTimeoutMs = 5000, pollIntervalMs = 180 } = {}) {
    this.driver = driver;
    this.signal = signal;
    this.onLog = onLog;
    this.maxRooms = Number.isFinite(maxRooms) ? Math.max(1, Math.min(100, Math.floor(maxRooms))) : 12;
    this.maxAttempts = this.maxRooms * 2;
    this.knownRoomNames = new Set(knownRoomNames);
    this.entryTimeoutMs = entryTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.visited = [];
    this.tried = new Set();
    this.failed = 0;
    this.passwordSkipped = 0;
    this.exhausted = false;
    this.preferredRoomName = null;
    this.size = { w: 1080, h: 1920 };
    this.sizeReady = false;
    this.homeConfirmed = false;
  }
  getStatus() {
    return { visited: [...this.visited], visitedCount: this.visited.length, failed: this.failed, passwordSkipped: this.passwordSkipped, tried: [...this.tried], exhausted: this.exhausted, preferredRoomName: this.preferredRoomName };
  }
  _visible(node, { minWidth = 1, minHeight = 1 } = {}) {
    return !!node && node.enabled !== false && [node.x, node.y, node.x2, node.y2].every(Number.isFinite) &&
      node.x >= 0 && node.y >= 0 && node.x2 <= this.size.w && node.y2 <= this.size.h &&
      node.x2 - node.x >= minWidth && node.y2 - node.y >= minHeight;
  }
  async _snapshot() {
    throwIfAborted(this.signal);
    const { nodes } = await this.driver.bridge.dumpUi({ signal: this.signal });
    throwIfAborted(this.signal);
    // wm size can report the physical landscape panel while Android uses portrait.
    const root = nodes[0];
    if (root?.packageName === PACKAGE && /(?:FrameLayout|View)$/.test(root.className || '') &&
      root.x === 0 && Number.isFinite(root.y) && root.y >= 0 && root.y < root.y2 && Number.isFinite(root.x2) && Number.isFinite(root.y2) && root.x2 >= 320 && root.y2 >= 320) {
      this.size = { w: root.x2, h: root.y2 };
      this.sizeReady = true;
    }
    else if (!this.sizeReady) {
      this.size = await this.driver.adb.screenSize();
      this.sizeReady = true;
    }
    const firstPackage = nodes.find(node => this._visible(node) && node.packageName)?.packageName;
    if (firstPackage !== PACKAGE)
      throw new Error('ROOM_NAVIGATION_WRONG_PACKAGE');
    return nodes.filter(node => this._visible(node) && (!node.packageName || node.packageName === PACKAGE));
  }
  _room(nodes) {
    if (this._membersTitle(nodes) || this._userCard(nodes) || this._passwordGate(nodes))
      return null;
    const header = nodes.find(node => node.shortId === 'tv_room_name' && node.text?.trim());
    const code = nodes.find(node => node.shortId === 'tv_room_code' && /\d{3,}/.test(node.text || ''));
    if (!header || !code || !nodes.some(node => node.shortId === 'layout_online_user') || !nodes.some(node => node.shortId === 'iv_quit'))
      return null;
    const online = nodes.find(node => node.shortId === 'tv_online_count');
    return { room: header.text.trim(), roomCode: /\d{3,}/.exec(code.text)?.[0] || null, onlineCount: /\d+/.exec(online?.text || '')?.[0] ? Number(/\d+/.exec(online.text)[0]) : null, nodes };
  }
  _membersTitle(nodes) {
    return nodes.find(node => node.shortId === 'tvTitle' && /^房间在线用户[（(]\d+人[)）]$/.test(node.text || ''));
  }
  _passwordGate(nodes) {
    // Require a room-specific prompt AND an input. Chat, nicknames and login
    // password fields alone must never cause navigation.
    return isRoomPasswordGate(nodes);
  }
  async _dismissPasswordGate(nodes) {
    if (!this._passwordGate(nodes))
      return nodes;
    throwIfAborted(this.signal);
    if (typeof this.driver.adb.back === 'function') {
      await this.driver.adb.back();
      throwIfAborted(this.signal);
      // Back may only hide the input keyboard. Re-check the actual dialog
      // before a second, bounded dismissal; never back blindly on another page.
      await abortableSleep(this.pollIntervalMs, this.signal);
      const remaining = await this._snapshot();
      if (this._passwordGate(remaining)) {
        const cancel = remaining.filter(node => node.clickable && ['取消', '返回'].includes(node.text) &&
          !['nickname', 'tv_nickname', 'content', 'tv_bubble_content', 'tv_room_name'].includes(node.shortId));
        if (cancel.length === 1)
          await this._tap(cancel[0]);
        else {
          await this.driver.adb.back();
          throwIfAborted(this.signal);
        }
      }
    }
    else {
      const cancel = nodes.filter(node => node.clickable && ['取消', '返回'].includes(node.text) &&
        !['nickname', 'tv_nickname', 'content', 'tv_bubble_content', 'tv_room_name'].includes(node.shortId));
      if (cancel.length !== 1)
        return null;
      await this._tap(cancel[0]);
    }
    return this._wait(current => !this._passwordGate(current) &&
      (this._homeList(current) || this._room(current) || current.some(node => node.shortId === 'll_tab_home')) ? current : null);
  }
  _userCard(nodes) {
    return isOperationRoomCard(nodes) || nodes.some(node => node.shortId === 'rv_top_bg') &&
      nodes.some(node => node.shortId === 'tv_nickname' && node.text?.trim()) &&
      nodes.some(node => node.shortId === 'tv_user_code' && /\d+/.test(node.text || ''));
  }
  async _recoverUserCard(nodes) {
    if (!this._userCard(nodes))
      return nodes;
    if (typeof this.driver.adb.back !== 'function')
      return null;
    throwIfAborted(this.signal);
    await this.driver.adb.back();
    throwIfAborted(this.signal);
    const meta = await this._wait(current => this._room(current));
    return meta?.nodes || null;
  }
  _roomMenu(nodes) {
    return nodes.some(node => node.clickable && ['举报房间', '分享房间', '关闭房间', '最小化'].includes(node.text));
  }
  _remember(meta) {
    if (!this.visited.includes(meta.room))
      this.visited.push(meta.room);
    this.tried.add(meta.room);
    return meta;
  }
  _homeList(nodes) {
    const region = nodes.find(node => node.shortId === 'rv_recommend_room');
    if (region)
      this.homeConfirmed = true;
    const main = nodes.find(node => node.shortId === 'mRecyclerView' && /RecyclerView/.test(node.className || ''));
    if (main && this.homeConfirmed && nodes.some(node => node.shortId === 'll_tab_home'))
      return main;
    if (!region)
      return null;
    if (/RecyclerView/.test(region.className || ''))
      return region;
    return nodes.find(node => /RecyclerView/.test(node.className || '') && inside(node, region)) || null;
  }
  _cards(nodes) {
    const container = this._homeList(nodes);
    if (!container)
      return [];
    const names = new Set();
    return nodes.filter(node => node.shortId === 'tv_room_name' && node.text?.trim() &&
      this._visible(node, { minWidth: 60, minHeight: 24 }) && inside(node, container))
      .filter(node => {
      const name = node.text.trim();
      if (names.has(name))
        return false;
      names.add(name);
      return true;
    });
  }
  async _tap(node) {
    throwIfAborted(this.signal);
    if (!this._visible(node))
      throw new Error('ROOM_NAVIGATION_INVALID_TARGET');
    if (node.shortId === 'tv_room_name' || node.shortId === 'iv_quit')
      this.homeConfirmed = false;
    await this.driver.adb.tap((node.x + node.x2) / 2, (node.y + node.y2) / 2);
    throwIfAborted(this.signal);
  }
  async _wait(predicate, { allowExitConfirmation = false, stopOnPassword = false } = {}) {
    const deadline = Date.now() + this.entryTimeoutMs;
    let confirmedExit = false;
    do {
      const nodes = await this._snapshot();
      if (stopOnPassword && this._passwordGate(nodes))
        return { passwordRequired: true, nodes };
      const result = predicate(nodes);
      if (result)
        return result;
      if (allowExitConfirmation && !confirmedExit) {
        const controls = nodes.filter(node => node.clickable && ['退出', '退出房间'].includes(node.text) &&
          !['nickname', 'tv_nickname', 'content', 'tv_bubble_content', 'tv_room_name'].includes(node.shortId));
        if (controls.length === 1) {
          confirmedExit = true;
          await this._tap(controls[0]);
        }
      }
      if (Date.now() >= deadline)
        break;
      await abortableSleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), this.signal);
    } while (Date.now() <= deadline);
    return null;
  }
  async _goHome(nodes) {
    nodes = await this._dismissPasswordGate(nodes);
    if (!nodes)
      return null;
    // Restarting collection after a private task can leave a known chat,
    // profile or search screen. Use only its observed toolbar back control.
    for (let step=0;step<4;step++) {
      const page=this._auxiliaryPage(nodes);
      if (!page) break;
      const back=nodes.filter(n=>n.shortId==='iv_back');
      if(back.length!==1)return null;
      await this._tap(back[0]);
      nodes=await this._wait(current=>this._auxiliaryPage(current)!==page?current:null);
      if(!nodes)return null;
    }
    if(this._auxiliaryPage(nodes))return null;
    nodes = await this._recoverUserCard(nodes);
    if (!nodes)
      return null;
    if (this._homeList(nodes))
      return nodes;
    const memberTitle = this._membersTitle(nodes);
    if (memberTitle) {
      const back = nodes.filter(node => node.shortId === 'ivBack');
      if (back.length !== 1)
        return null;
      await this._tap(back[0]);
      const meta = await this._wait(current => this._room(current));
      if (!meta)
        return null;
      nodes = meta.nodes;
    }
    if (this._room(nodes)) {
      if (typeof this.driver.adb.back === 'function') {
        // The real iv_quit opens a toolbar; closing the cloud room is not navigation.
        for (let step = 0; step < 2; step++) {
          nodes = await this._snapshot();
          if (nodes.some(node => node.shortId === 'll_tab_home'))
            break;
          if (!this._room(nodes))
            return null;
          const menuWasOpen = this._roomMenu(nodes);
          throwIfAborted(this.signal);
          await this.driver.adb.back();
          throwIfAborted(this.signal);
          const changed = await this._wait(current => {
            if (current.some(node => node.shortId === 'll_tab_home'))
              return current;
            if (menuWasOpen && !this._roomMenu(current) && this._room(current))
              return current;
            return null;
          }, { allowExitConfirmation: true });
          nodes = changed || await this._snapshot();
          if (nodes.some(node => node.shortId === 'll_tab_home'))
            break;
        }
        if (!nodes.some(node => node.shortId === 'll_tab_home'))
          return null;
      }
      else {
        // Legacy/synthetic drivers without back support retain exact exit confirmation.
        const quit = nodes.filter(node => node.shortId === 'iv_quit');
        if (quit.length !== 1)
          return null;
        await this._tap(quit[0]);
        nodes = await this._wait(current => current.some(node => node.shortId === 'll_tab_home') ? current : null, { allowExitConfirmation: true });
        if (!nodes)
          return null;
      }
    }
    if (this._homeList(nodes))
      return nodes;
    const tab = nodes.filter(node => node.shortId === 'll_tab_home');
    if (tab.length !== 1)
      return null;
    await this._tap(tab[0]);
    return this._wait(current => this._homeList(current) ? current : null);
  }
  _auxiliaryPage(nodes) {
    const one=id=>nodes.filter(n=>n.shortId===id).length===1;
    if(!one('iv_back'))return null;
    if(one('input_message')&&one('iv_send')&&one('tv_nickname'))return 'private-chat';
    if(one('iv_chat')&&one('iv_follow')&&one('iv_copy')&&one('tv_nickname')&&
      nodes.some(n=>['tv_nice_num','tv_user_code'].includes(n.shortId)&&/^\d+$/.test(n.text||'')))return 'full-profile';
    if(one('et_search')&&one('tv_search'))return 'search-entry';
    if(one('et_search')&&one('tv_cancel')&&nodes.some(n=>n.text==='用户'&&n.clickable))return 'search-results';
    return null;
  }
  async ensureRoom({ preferredRoomName } = {}) {
    if (preferredRoomName != null)
      this.preferredRoomName = String(preferredRoomName).trim() || null;
    let nodes = await this._snapshot();
    nodes = await this._recoverUserCard(nodes);
    if (!nodes)
      return null;
    if (this._membersTitle(nodes)) {
      const back = nodes.filter(node => node.shortId === 'ivBack');
      if (back.length !== 1)
        return null;
      await this._tap(back[0]);
      const meta = await this._wait(current => this._room(current));
      if (!meta)
        return null;
      nodes = meta.nodes;
    }
    const current = this._room(nodes);
    if (current && (!this.preferredRoomName || current.room === this.preferredRoomName))
      return this._remember(current);
    return this.nextRoom();
  }
  async returnHome() {
    return this._goHome(await this._snapshot());
  }
  async nextRoom() {
    throwIfAborted(this.signal);
    if (!this.preferredRoomName && (this.visited.length >= this.maxRooms || this.exhausted))
      return null;
    let nodes = await this._snapshot();
    const current = this._room(nodes);
    if (this.preferredRoomName && current?.room === this.preferredRoomName)
      return this._remember(current);
    if (this.visited.length >= this.maxRooms || this.exhausted)
      return null;
    nodes = await this._goHome(nodes);
    if (!nodes) {
      this.failed++;
      return null;
    }
    const signatures = new Set();
    for (let page = 0; page <= 4; page++) {
      throwIfAborted(this.signal);
      const cards = this._cards(nodes);
      const signature = cards.map(node => node.text.trim()).join('|');
      if (signatures.has(signature))
        break;
      signatures.add(signature);
      const names = cards.map(node => node.text.trim()).sort((a, b) => Number(this.knownRoomNames.has(a)) - Number(this.knownRoomNames.has(b)));
      for (const name of names) {
        if (this.tried.has(name) || (this.preferredRoomName && name !== this.preferredRoomName))
          continue;
        if (this.tried.size >= this.maxAttempts) {
          this.exhausted = true;
          return null;
        }
        this.tried.add(name);
        const fresh = await this._snapshot();
        const card = this._cards(fresh).find(node => node.text.trim() === name);
        if (!card)
          continue;
        try {
          await this._tap(card);
          const entered = await this._wait(currentNodes => this._room(currentNodes), { stopOnPassword: true });
          if (entered?.passwordRequired) {
            this.passwordSkipped++;
            this.onLog('info', `房间需要密码，返回并跳过: ${name}`);
          }
          if (entered && entered.room === name)
            return this._remember(entered);
          this.failed++;
          if (!entered?.passwordRequired)
            this.onLog('warn', `房间未确认进入，跳过: ${name}`);
        }
        catch (error) {
          if (isAbortError(error))
            throw error;
          this.failed++;
          this.onLog('warn', `房间导航失败: ${name} (${error.message})`);
        }
        nodes = await this._goHome(await this._snapshot());
        if (!nodes)
          return null;
      }
      if (page === 4)
        break;
      nodes = await this._snapshot();
      const list = this._homeList(nodes);
      if (!list)
        break;
      if (list.shortId === 'rv_recommend_room') {
        const y = (list.y + list.y2) / 2;
        await this.driver.adb.swipe(list.x + (list.x2 - list.x) * 0.8, y, list.x + (list.x2 - list.x) * 0.2, y, 400);
      }
      else {
        const x = (list.x + list.x2) / 2;
        await this.driver.adb.swipe(x, list.y + (list.y2 - list.y) * 0.8, x, list.y + (list.y2 - list.y) * 0.25, 400);
      }
      await abortableSleep(this.pollIntervalMs, this.signal);
      nodes = await this._snapshot();
    }
    this.exhausted = true;
    return null;
  }
}
export default RoomNavigator;
